// F5 long-press global hotkey via the XDG Desktop Portal GlobalShortcuts v2
// interface (org.freedesktop.portal.GlobalShortcuts).
//
// Why the portal: the process runs as an unprivileged user and /dev/input is
// root:input 0660, so evdev is not readable without sudo; the session is
// Wayland, so X11 grabs are not available either. The portal is the supported,
// permission-free way to receive a global shortcut.
//
// Semantics: holding the shortcut key is "push to talk".
//   Activated  -> start long-press timer
//   Deactivated before longPressMs -> short tap, ignored
//   still held at longPressMs -> onWake() (+ the ASR module starts capturing)
//   Deactivated after a successful long press -> onEnd() (endCapture)
//
// The portal requires an application id; for unsandboxed apps this is provided
// by org.freedesktop.host.portal.Registry.Register() and requires a
// `<app-id>.desktop` file to exist in the XDG applications dirs. We create
// ~/.local/share/applications/figaro.desktop automatically if it is missing
// (see ensureDesktopEntry()).
//
// First use shows a KDE confirmation dialog ("Figaro 想要绑定快捷键 F5") which
// the user must accept once. Until then the module reports state
// 'awaiting-user' and everything else (wake word, F5 retry on next start) works.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, variant } from './dbus.js';

export const APP_ID = 'figaro';
export const SHORTCUT_ID = 'figaro-talk';
const PORTAL_DEST = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const GS_IFACE = 'org.freedesktop.portal.GlobalShortcuts';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';
const REGISTRY_IFACE = 'org.freedesktop.host.portal.Registry';

/**
 * Pure long-press detector — no D-Bus, no portal, therefore unit-testable.
 *
 * @param {object} opts
 * @param {number} opts.longPressMs hold threshold
 * @param {(info: {heldMs: number}) => void} [opts.onLongPress] fired at the threshold while still held
 * @param {(info: {heldMs: number}) => void} [opts.onRelease] release after a long press
 * @param {(info: {heldMs: number}) => void} [opts.onTap] short press (below threshold)
 * @param {() => number} [opts.now]
 */
export function createLongPressDetector(opts) {
  const {
    longPressMs,
    onLongPress = () => {},
    onRelease = () => {},
    onTap = () => {},
    now = () => Date.now(),
  } = opts;
  let pressedAt = -1;
  let timer = null;
  let longPressed = false;

  function clear() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    get pressed() {
      return pressedAt >= 0;
    },
    get longPressed() {
      return longPressed;
    },
    press() {
      if (pressedAt >= 0) return; // ignore auto-repeat / duplicate Activated
      pressedAt = now();
      longPressed = false;
      clear();
      timer = setTimeout(() => {
        timer = null;
        if (pressedAt < 0) return;
        longPressed = true;
        try { onLongPress({ heldMs: now() - pressedAt }); } catch { /* ignore */ }
      }, longPressMs);
    },
    release() {
      if (pressedAt < 0) return;
      const heldMs = now() - pressedAt;
      pressedAt = -1;
      clear();
      try {
        if (longPressed) onRelease({ heldMs });
        else onTap({ heldMs });
      } catch { /* ignore */ }
    },
    /** Forget state without emitting callbacks (e.g. on stop). */
    cancel() {
      pressedAt = -1;
      longPressed = false;
      clear();
    },
  };
}

/** Path of the .desktop entry that matches APP_ID. */
export function desktopEntryPath() {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'applications', `${APP_ID}.desktop`);
}

/**
 * Create ~/.local/share/applications/figaro.desktop if missing.
 * The portal's host-app registry requires the app id to match a .desktop file.
 * @returns {{path: string, created: boolean}}
 */
export function ensureDesktopEntry() {
  const file = desktopEntryPath();
  if (fs.existsSync(file)) return { path: file, created: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const exec = [process.execPath, process.argv[1]].filter(Boolean).join(' ');
  const content = `[Desktop Entry]
Type=Application
Name=Figaro
Name[zh_CN]=费加罗
Comment=Figaro voice assistant
Exec=${exec} daemon
Icon=audio-input-microphone
Terminal=false
NoDisplay=true
StartupNotify=false
Categories=Utility;
`;
  fs.writeFileSync(file, content, { mode: 0o644 });
  return { path: file, created: true };
}

function dictToObject(pairs) {
  const out = {};
  for (const [k, v] of pairs ?? []) out[k] = v && typeof v === 'object' && 'value' in v ? v.value : v;
  return out;
}

function triggerFor(hotkey) {
  // Portal expects the XDG shortcuts spec format; a plain key is valid.
  const raw = String(hotkey ?? '').trim();
  if (!raw) return '';
  if (raw.includes('+') || /^[A-Z0-9]+$/.test(raw) === false) return raw;
  return raw;
}

/**
 * Create the global-shortcut (F5 long press) handler.
 *
 * @param {object} opts
 * @param {object} opts.config full config (uses config.asr.hotkey / longPressMs)
 * @param {() => void} opts.onWake long press reached the threshold
 * @param {() => void} [opts.onEnd] released after a long press -> endCapture()
 * @param {(err: Error) => void} [opts.onError] non-fatal problem (also used for "需要用户确认")
 * @param {(msg: string) => void} [opts.onLog] verbose progress log
 * @param {(state: string) => void} [opts.onState] state changes for tests/UI
 * @param {Function} [opts.connectFn] injected D-Bus connector (tests)
 * @param {number} [opts.bindTimeoutMs] how long to wait for the user's dialog (default 0 = forever)
 */
export function createHotkey(opts) {
  const {
    config,
    onWake = () => {},
    onEnd = () => {},
    onError = () => {},
    onLog = () => {},
    onState = () => {},
    connectFn = connect,
    bindTimeoutMs = 0,
    longPressMs: longPressOverride,
  } = opts;
  const asrCfg = config?.asr ?? {};
  const hotkey = String(asrCfg.hotkey ?? '').trim();
  const longPressMs = longPressOverride ?? asrCfg.longPressMs ?? 260;

  let conn = null;
  let sessionPath = null;
  let state = 'idle';
  let stopped = false;
  let unsubscribers = [];
  let bindTimer = null;

  const detector = createLongPressDetector({
    longPressMs,
    onLongPress: () => {
      onLog(`long press (>= ${longPressMs}ms) -> wake`);
      try { onWake(); } catch (err) { onError(err instanceof Error ? err : new Error(String(err))); }
    },
    onRelease: ({ heldMs }) => {
      onLog(`released after ${Math.round(heldMs)}ms -> endCapture`);
      try { onEnd(); } catch (err) { onError(err instanceof Error ? err : new Error(String(err))); }
    },
    onTap: ({ heldMs }) => {
      onLog(`short tap ${Math.round(heldMs)}ms (< ${longPressMs}ms) ignored`);
    },
  });

  function setState(next, detail) {
    if (state === next) return;
    state = next;
    try { onState(next, detail); } catch { /* ignore */ }
  }

  function fail(message, extra) {
    const err = new Error(message);
    if (extra) Object.assign(err, extra);
    setState('unavailable');
    try { onError(err); } catch { /* ignore */ }
  }

  function waitResponse(path, timeoutMs) {
    return new Promise((resolve) => {
      if (stopped) { resolve(null); return; }
      let timer = null;
      const off = conn.onSignal({ interface: REQUEST_IFACE, member: 'Response' }, (sig) => {
        if (sig.path !== path) return;
        cleanup();
        resolve(sig.args);
      });
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        off();
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
      }
    });
  }

  async function setup() {
    setState('starting');
    try {
      conn = await connectFn();
    } catch (err) {
      fail(`无法连接 D-Bus 会话总线，F5 长按不可用（语音唤醒仍可用）：${err.message}`, {
        code: 'HOTKEY_NO_BUS',
        hint: '如果在 systemd 用户服务中运行，请确保 DBUS_SESSION_BUS_ADDRESS 可用',
      });
      return;
    }
    if (stopped) { conn.close(); return; }
    const c = conn;
    unsubscribers.push(c.onSignal({ interface: GS_IFACE, member: 'Activated' }, (sig) => {
      const [sigSession, id] = sig.args;
      if (sessionPath && sigSession !== sessionPath) return;
      if (id !== SHORTCUT_ID) return;
      detector.press();
    }));
    unsubscribers.push(c.onSignal({ interface: GS_IFACE, member: 'Deactivated' }, (sig) => {
      const [sigSession, id] = sig.args;
      if (sessionPath && sigSession !== sessionPath) return;
      if (id !== SHORTCUT_ID) return;
      detector.release();
    }));
    unsubscribers.push(c.onSignal({ interface: GS_IFACE, member: 'ShortcutsChanged' }, () => {
      onLog('portal: ShortcutsChanged (用户修改了快捷键配置)');
    }));

    try {
      await c.addMatch(`type='signal',interface='${GS_IFACE}'`);
      await c.addMatch(`type='signal',interface='${REQUEST_IFACE}'`);
    } catch (err) {
      fail(`无法订阅 portal 信号，F5 长按不可用：${err.message}`, { code: 'HOTKEY_MATCH' });
      return;
    }

    // Register this connection as the "figaro" app (host app registry).
    try {
      const entry = ensureDesktopEntry();
      if (entry.created) onLog(`created ${entry.path} (portal app id registration)`);
      await c.call({
        destination: PORTAL_DEST,
        path: PORTAL_PATH,
        interface: REGISTRY_IFACE,
        member: 'Register',
        signature: 'sa{sv}',
        body: [APP_ID, {}],
      });
    } catch (err) {
      // Older portals lack the registry; try anyway, the error below explains it.
      onLog(`host app registry unavailable (${err.message}); continuing`);
    }
    if (stopped) return;

    // Create a GlobalShortcuts session.
    const token = `figaro${process.pid}`;
    let session;
    try {
      const reply = await c.call({
        destination: PORTAL_DEST,
        path: PORTAL_PATH,
        interface: GS_IFACE,
        member: 'CreateSession',
        signature: 'a{sv}',
        body: [{ handle_token: variant('s', token), session_handle_token: variant('s', token) }],
        timeoutMs: 15000,
      });
      const reqPath = reply[0];
      const response = await waitResponse(reqPath, 15000);
      if (!response) {
        fail('portal CreateSession 超时（xdg-desktop-portal 未响应）', { code: 'HOTKEY_SESSION_TIMEOUT' });
        return;
      }
      const [code, rawResults] = response;
      if (code !== 0) {
        fail(`portal CreateSession 被拒绝 (code=${code})`, { code: 'HOTKEY_SESSION_DENIED' });
        return;
      }
      session = dictToObject(rawResults).session_handle;
      if (!session) {
        fail('portal CreateSession 未返回 session handle', { code: 'HOTKEY_SESSION_EMPTY' });
        return;
      }
      sessionPath = session;
    } catch (err) {
      fail(
        `无法创建 GlobalShortcuts 会话，F5 长按不可用：${err.message}`,
        { code: 'HOTKEY_SESSION', hint: '确认 xdg-desktop-portal 与 org.freedesktop.portal.GlobalShortcuts v2 可用；否则请用语音唤醒「费加罗」' },
      );
      return;
    }

    // Bind the shortcut. This is where KDE shows the confirmation dialog.
    setState('awaiting-user');
    const wantTrigger = triggerFor(hotkey);
    let requestPath;
    try {
      const reply = await c.call({
        destination: PORTAL_DEST,
        path: PORTAL_PATH,
        interface: GS_IFACE,
        member: 'BindShortcuts',
        signature: 'oa(sa{sv})sa{sv}',
        body: [
          sessionPath,
          [[SHORTCUT_ID, {
            description: variant('s', '费加罗：按住说话 / 唤醒'),
            preferred_trigger: variant('s', wantTrigger),
          }]],
          '',
          { handle_token: variant('s', `bind${process.pid}`) },
        ],
        timeoutMs: 15000,
      });
      requestPath = reply[0];
    } catch (err) {
      fail(
        `portal BindShortcuts 失败，F5 长按不可用：${err.message}`,
        { code: 'HOTKEY_BIND', hint: '如果提示 app id：确认 ~/.local/share/applications/figaro.desktop 存在' },
      );
      return;
    }
    onLog(
      `已请求绑定 ${wantTrigger || '(用户自选按键)'}：若桌面弹出「费加罗 想要绑定快捷键」对话框，请点击「允许/确定」（只需一次）`,
    );
    const response = await waitResponse(requestPath, bindTimeoutMs);
    if (!response) {
      // No dialog result yet (bindTimeoutMs === 0 means forever). Keep waiting in
      // the background: the shortcut may still be approved later.
      onLog('等待用户确认快捷键绑定中（F5 长按在确认前不可用）');
      return;
    }
    const [code, rawResults] = response;
    if (code === 0) {
      const results = dictToObject(rawResults);
      const list = Array.isArray(results.shortcuts) ? results.shortcuts : [];
      const bound = list.some((entry) => {
        const id = Array.isArray(entry) ? entry[0] : entry?.id;
        if (id !== SHORTCUT_ID) return false;
        const props = Array.isArray(entry) ? dictToObject(entry[1]) : {};
        const trigger = props.trigger_description ?? '';
        if (!trigger) onLog('portal 返回的快捷键描述为空（可能已注册但未分配按键，见 ~/.config/kglobalshortcutsrc）');
        return true;
      });
      setState(bound ? 'bound' : 'denied');
      if (bound) {
        const props = dictToObject(list.find((e) => (Array.isArray(e) ? e[0] : e?.id) === SHORTCUT_ID)?.[1]);
        onLog(`F5 长按已绑定（用户确认）。快捷键: ${props.trigger_description || wantTrigger || '见系统设置'}`);
      } else {
        fail(
          '用户在 portal 对话框中未绑定「figaro-talk」快捷键，F5 长按不可用',
          { code: 'HOTKEY_NOT_BOUND', hint: '重新启动费加罗可在下次弹出授权对话框；或语音唤醒「费加罗」' },
        );
      }
    } else {
      fail('用户取消了 portal 快捷键授权对话框，F5 长按不可用（语音唤醒仍可用）', { code: 'HOTKEY_CANCELLED' });
    }
  }

  return {
    get state() {
      return state;
    },
    get bound() {
      return state === 'bound';
    },
    get sessionPath() {
      return sessionPath;
    },
    async start() {
      if (!hotkey) {
        setState('disabled');
        onLog('config.asr.hotkey 为空，F5 长按已禁用');
        return;
      }
      if (stopped) return;
      // Never reject: the daemon must start even if the portal is unavailable.
      setup().catch((err) => fail(`F5 长按初始化异常：${err.message}`, { code: 'HOTKEY_SETUP' }));
      // Give setup a brief chance to report obvious failures, but do not block on
      // the user dialog.
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
    async stop() {
      stopped = true;
      detector.cancel();
      for (const off of unsubscribers) { try { off(); } catch { /* ignore */ } }
      unsubscribers = [];
      if (bindTimer) { clearTimeout(bindTimer); bindTimer = null; }
      if (conn) {
        try { conn.close(); } catch { /* ignore */ }
        conn = null;
      }
      setState('stopped');
    },
  };
}

export default { createHotkey, createLongPressDetector, ensureDesktopEntry, desktopEntryPath, APP_ID, SHORTCUT_ID };
