// F5 long-press global hotkey via the XDG Desktop Portal GlobalShortcuts v2
// interface (org.freedesktop.portal.GlobalShortcuts).
//
// Why the portal: the process runs as an unprivileged user and /dev/input is
// root:input 0660, so evdev is not readable without sudo; the session is
// Wayland, so X11 grabs are not available either. The portal is the supported,
// permission-free way to receive a global shortcut.
//
// Semantics: holding the shortcut key is "push to talk".
//   Activated (press)            -> start long-press timer
//   Deactivated before longPressMs -> short tap, ignored
//   still held at longPressMs    -> onWake() (+ the ASR module starts capturing)
//   Deactivated after a long press -> onEnd() (endCapture)
//
// The portal requires an application id; for unsandboxed apps it comes from
// org.freedesktop.host.portal.Registry.Register() plus a `<app-id>.desktop`
// file in the XDG applications dirs. We create
// ~/.local/share/applications/figaro.desktop if it is missing.
//
// First use shows a KDE dialog ("Figaro 想要绑定快捷键 F5") which the user must
// accept once; KDE persists the result in ~/.config/kglobalshortcutsrc. Until
// then everything else works and the module keeps trying to notice a binding
// appearing later (ShortcutsChanged signal + periodic ListShortcuts), so the
// user does NOT have to restart Figaro after clicking "allow".

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

/** Extract [{id, description, trigger}] from a Response payload's results. */
function parseShortcutList(rawResults) {
  const results = dictToObject(rawResults);
  const list = Array.isArray(results.shortcuts) ? results.shortcuts : [];
  return list.map((entry) => {
    const id = Array.isArray(entry) ? entry[0] : entry?.id;
    const props = Array.isArray(entry) ? dictToObject(entry[1]) : {};
    return { id, description: props.description ?? '', trigger: props.trigger_description ?? '' };
  });
}

const MOD_ORDER = ['CTRL', 'ALT', 'SHIFT', 'LOGO'];
const MOD_ALIASES = new Map([
  ['ctrl', 'CTRL'], ['control', 'CTRL'],
  ['alt', 'ALT'], ['option', 'ALT'],
  ['shift', 'SHIFT'],
  ['meta', 'LOGO'], ['super', 'LOGO'], ['win', 'LOGO'], ['logo', 'LOGO'], ['cmd', 'LOGO'],
]);

/**
 * Normalise a shortcut string to the XDG shortcuts / GTK accelerator format the
 * portal expects: `CTRL+ALT+SHIFT+LOGO+KEY`, fixed modifier order, upper-case
 * key names. '' means "disabled"/"let the user pick".
 *
 * @param {string} raw e.g. "ctrl+alt+f5", "Control+Alt+F5", "F5"
 * @returns {string} e.g. "CTRL+ALT+F5"
 */
export function normalizeTrigger(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const mods = new Set();
  let key = '';
  for (const part of text.split('+').map((p) => p.trim()).filter(Boolean)) {
    const mod = MOD_ALIASES.get(part.toLowerCase());
    if (mod) { mods.add(mod); continue; }
    key = part.length === 1 ? part.toUpperCase() : part.toUpperCase();
  }
  if (!key) return '';
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

function triggerFor(hotkey) {
  return normalizeTrigger(hotkey);
}

/**
 * Create the global-shortcut (F5 long press) handler.
 *
 * @param {object} opts
 * @param {object} opts.config full config (uses config.asr.hotkey / longPressMs)
 * @param {() => void} opts.onWake long press reached the threshold
 * @param {() => void} [opts.onTap] short press (below longPressMs) -> cancel, no capture
 * @param {() => void} [opts.onEnd] released after a long press -> endCapture()
 * @param {(err: Error) => void} [opts.onError] non-fatal problem (also used for "需要用户确认")
 * @param {(msg: string) => void} [opts.onLog] verbose progress log
 * @param {(state: string) => void} [opts.onState] state changes for tests/UI
 * @param {Function} [opts.connectFn] injected D-Bus connector (tests)
 * @param {number} [opts.bindTimeoutMs] 0 = wait forever for the user's dialog
 * @param {number} [opts.recheckIntervalMs] ListShortcuts poll while not bound (default 10000)
 * @param {number} [opts.maxBindRetries] transient D-Bus bind failures to retry (default 2)
 * @param {number} [opts.sessionTimeoutMs] CreateSession/BindShortcuts response wait (default 15000)
 * @param {number[]} [opts.sessionRetryDelaysMs] delays before retrying a slow portal session
 * @param {number} [opts.sessionRecheckDelayMs] after giving up, how often to try again (0 = never)
 * @param {number} [opts.maxSessionRechecks] upper bound of those periodic attempts
 */
export function createHotkey(opts) {
  const {
    config,
    onWake = () => {},
    onTap = () => {},
    onEnd = () => {},
    onError = () => {},
    onLog = () => {},
    onState = () => {},
    connectFn = connect,
    bindTimeoutMs = 0,
    recheckIntervalMs = 10000,
    maxBindRetries = 2,
    maxCancelRetries = 2,
    cancelRetryDelayMs = 30000,
    // A logout/login cycle starts this unit before xdg-desktop-portal and the
    // KDE shortcut backend are ready: CreateSession then times out. The old code
    // gave up after 16s, so the hotkey stayed dead for the whole session even
    // though the portal recovered a few seconds later. Keep trying for ~50s,
    // then re-check periodically so a slow login heals itself.
    sessionTimeoutMs = 15000,
    sessionRetryDelaysMs = [2000, 3000, 5000, 8000, 12000, 20000],
    sessionRecheckDelayMs = 60000,
    maxSessionRechecks = 10,
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
  let recheckTimer = null;
  let retryTimer = null;
  let bindRetries = 0;
  let cancelRetries = 0;
  let sessionRetries = 0;
  let sessionRecheckTimer = null;
  let sessionRecheckCount = 0;
  let recheckInFlight = false;
  let seq = 0;

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
      // Siri-style "tap to shut up": a short press is a cancel signal, never a
      // wake (it must not start a capture).
      onLog(`short tap ${Math.round(heldMs)}ms (< ${longPressMs}ms) -> onTap（取消）`);
      try { onTap(); } catch (err) { onError(err instanceof Error ? err : new Error(String(err))); }
    },
  });

  function setState(next, detail) {
    if (state === next) return;
    state = next;
    try { onState(next, detail); } catch { /* ignore */ }
  }

  function fail(message, extra, { recoverable = false } = {}) {
    const err = new Error(message);
    if (extra) Object.assign(err, extra);
    setState('unavailable');
    try { onError(err); } catch { /* ignore */ }
    if (recoverable) startRecheck();
  }

  function waitResponse(requestPath, timeoutMs) {
    return new Promise((resolve) => {
      if (stopped || !conn) { resolve(null); return; }
      let timer = null;
      const off = conn.onSignal({ interface: REQUEST_IFACE, member: 'Response' }, (sig) => {
        if (sig.path !== requestPath) return;
        cleanup();
        resolve(sig.args);
      });
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        try { off(); } catch { /* ignore */ }
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
      }
    });
  }

  function startRecheck() {
    if (stopped || recheckTimer) return;
    recheckTimer = setInterval(() => { void refreshBinding(); }, recheckIntervalMs);
    recheckTimer.unref?.();
  }

  function stopRecheck() {
    if (recheckTimer) { clearInterval(recheckTimer); recheckTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (sessionRecheckTimer) { clearTimeout(sessionRecheckTimer); sessionRecheckTimer = null; }
  }

  /**
   * Ask the portal which shortcuts are active for this session. Used both as a
   * recovery path (user clicked allow after we started / bound manually in
   * System Settings) and as a periodic sanity check.
   */
  async function refreshBinding() {
    if (stopped || !conn || !sessionPath || recheckInFlight) return false;
    recheckInFlight = true;
    try {
      const token = `list${process.pid}${++seq}`;
      const reply = await conn.call({
        destination: PORTAL_DEST,
        path: PORTAL_PATH,
        interface: GS_IFACE,
        member: 'ListShortcuts',
        signature: 'oa{sv}',
        body: [sessionPath, { handle_token: variant('s', token) }],
        timeoutMs: 8000,
      });
      const response = await waitResponse(reply[0], 8000);
      if (!response) return false;
      const [code, rawResults] = response;
      if (code !== 0) return false;
      const shortcuts = parseShortcutList(rawResults);
      const mine = shortcuts.find((s) => s.id === SHORTCUT_ID);
      if (!mine) return false;
      if (!mine.trigger) {
        onLog('portal: figaro-talk 已注册但还没分配按键（等待用户确认或系统设置绑定）');
        return false;
      }
      if (state !== 'bound') {
        setState('bound');
        stopRecheck();
        onLog(`F5 长按已可用（ListShortcuts: "${mine.trigger}"）——无需重启费加罗`);
      }
      return true;
    } catch (err) {
      onLog(`ListShortcuts 失败: ${err.message}`);
      return false;
    } finally {
      recheckInFlight = false;
    }
  }

  async function createSessionAndBind() {
    if (stopped || !conn) return;
    if (state === 'bound') return;
    const token = `figaro${process.pid}${++seq}`;
    let session;
    try {
      const reply = await conn.call({
        destination: PORTAL_DEST,
        path: PORTAL_PATH,
        interface: GS_IFACE,
        member: 'CreateSession',
        signature: 'a{sv}',
        body: [{ handle_token: variant('s', token), session_handle_token: variant('s', token) }],
        timeoutMs: sessionTimeoutMs,
      });
      const response = await waitResponse(reply[0], sessionTimeoutMs);
      if (!response) {
        retrySession('portal CreateSession 超时（xdg-desktop-portal 未就绪）', 'HOTKEY_SESSION_TIMEOUT');
        return;
      }
      const [code, rawResults] = response;
      if (code !== 0) {
        retrySession(`portal CreateSession 被拒绝 (code=${code})`, 'HOTKEY_SESSION_DENIED');
        return;
      }
      session = dictToObject(rawResults).session_handle;
      if (!session) {
        retrySession('portal CreateSession 未返回 session handle', 'HOTKEY_SESSION_EMPTY');
        return;
      }
      sessionPath = session;
    } catch (err) {
      retryBind(`无法创建 GlobalShortcuts 会话：${err.message}`, 'HOTKEY_SESSION');
      return;
    }
    if (stopped) return;

    setState('awaiting-user');
    const normalized = triggerFor(hotkey);
    if (normalized !== String(hotkey).trim()) onLog(`[hotkey] trigger normalized: ${JSON.stringify(String(hotkey).trim())} -> ${JSON.stringify(normalized)}`);
    let requestPath;
    try {
      const reply = await conn.call({
        destination: PORTAL_DEST,
        path: PORTAL_PATH,
        interface: GS_IFACE,
        member: 'BindShortcuts',
        signature: 'oa(sa{sv})sa{sv}',
        body: [
          sessionPath,
          [[SHORTCUT_ID, {
            description: variant('s', '费加罗：按住说话 / 唤醒'),
            preferred_trigger: variant('s', triggerFor(hotkey)),
          }]],
          '',
          { handle_token: variant('s', `bind${process.pid}${seq}`) },
        ],
        timeoutMs: 15000,
      });
      requestPath = reply[0];
    } catch (err) {
      retryBind(`portal BindShortcuts 调用失败：${err.message}`, 'HOTKEY_BIND');
      startRecheck();
      return;
    }
    onLog(`已请求绑定 ${triggerFor(hotkey) || '(用户自选按键)'}：需要用户在桌面弹窗「Figaro 想要绑定快捷键」里点「允许/确定」（只需一次）`);
    startRecheck(); // recovery path: notice approval / manual binding even if response is missed
    const response = await waitResponse(requestPath, bindTimeoutMs);
    if (!response) {
      onLog('等待用户在 portal 对话框中确认快捷键（确认前 F5 不可用；确认后会自动生效，无需重启）');
      return;
    }
    const [code, rawResults] = response;
    if (code !== 0) {
      // The user may simply have been away / closed the dialog: keep the
      // shortcut request alive a couple more times instead of degrading forever.
      cancelRetries += 1;
      if (cancelRetries <= maxCancelRetries) {
        onLog(
          `portal 授权被取消（需要用户在弹窗点「确定」）。${Math.round(cancelRetryDelayMs / 1000)}s 后重试 ${cancelRetries}/${maxCancelRetries}`,
        );
        startRecheck();
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void createSessionAndBind();
        }, cancelRetryDelayMs);
        retryTimer.unref?.();
        setState('denied');
        return;
      }
      fail(
        'portal 快捷键授权多次被取消（需要用户在弹窗点「确定」；语音唤醒仍可用）。' +
        '之后可在系统设置→快捷键 里给 Figaro 手动绑定，或重启费加罗重试',
        { code: 'HOTKEY_CANCELLED' },
      );
      startRecheck();
      return;
    }
    const shortcuts = parseShortcutList(rawResults);
    const mine = shortcuts.find((s) => s.id === SHORTCUT_ID);
    if (mine) {
      setState('bound');
      stopRecheck();
      onLog(`F5 长按已绑定（用户确认）。快捷键: ${mine.trigger || triggerFor(hotkey) || '见系统设置'}`);
      return;
    }
    // Portal said success but did not return the shortcut; keep polling in case
    // the binding materialises (e.g. another dialog completes later).
    setState('denied');
    onLog('portal 返回成功但未包含 figaro-talk，继续轮询绑定状态…');
    startRecheck();
  }

  /** Retry a portal session that is not ready yet (login race). */
  function retrySession(message, code) {
    if (stopped) return;
    sessionRetries += 1;
    if (sessionRetries > sessionRetryDelaysMs.length) {
      fail(`${message}（已重试 ${sessionRetryDelaysMs.length} 次，F5 长按暂不可用；语音唤醒仍可用，稍后会自动再试）`, { code }, { recoverable: true });
      scheduleSessionRecheck();
      return;
    }
    const delay = Math.max(0, Number(sessionRetryDelaysMs[sessionRetries - 1]) || 0);
    const err = new Error(`${message}；${Math.round(delay / 1000)}s 后重试（${sessionRetries}/${sessionRetryDelaysMs.length}）`);
    err.code = code;
    setState('unavailable');
    try { onError(err); } catch { /* ignore */ }
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void createSessionAndBind();
    }, delay);
    retryTimer.unref?.();
  }

  /** After the retry burst is exhausted, keep a slow periodic attempt running. */
  function scheduleSessionRecheck() {
    if (stopped || sessionRecheckTimer || sessionRecheckDelayMs <= 0) return;
    if (sessionRecheckCount >= maxSessionRechecks) return;
    sessionRecheckTimer = setTimeout(() => {
      sessionRecheckTimer = null;
      sessionRecheckCount += 1;
      if (stopped || state === 'bound') return;
      sessionRetries = 0;
      onLog(`portal 快捷键恢复巡检（${sessionRecheckCount}/${maxSessionRechecks}）：重新尝试创建会话`);
      void createSessionAndBind();
    }, sessionRecheckDelayMs);
    sessionRecheckTimer.unref?.();
  }

  function retryBind(message, code) {
    if (stopped) return;
    bindRetries += 1;
    if (bindRetries > maxBindRetries) {
      fail(`${message}（已重试 ${maxBindRetries} 次，F5 长按不可用；语音唤醒仍可用）`, { code }, { recoverable: true });
      return;
    }
    const delay = 8000;
    const err = new Error(`${message}；${Math.round(delay / 1000)}s 后重试（${bindRetries}/${maxBindRetries}）`);
    err.code = code;
    setState('unavailable');
    try { onError(err); } catch { /* ignore */ }
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void createSessionAndBind();
    }, delay);
    retryTimer.unref?.();
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
      onLog('portal: ShortcutsChanged（快捷键配置有变化），重新检查绑定…');
      void refreshBinding();
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
      onLog(`host app registry unavailable (${err.message}); continuing`);
    }
    if (stopped) return;
    await createSessionAndBind();
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
    /** Re-read the binding from the portal (also done automatically). */
    async refresh() {
      return refreshBinding();
    },
    async start() {
      if (!hotkey) {
        setState('disabled');
        onLog('config.asr.hotkey 为空，F5 长按已禁用');
        return;
      }
      if (stopped) return;
      // Never reject: the daemon must start even if the portal is unavailable.
      setup().catch((err) => fail(`F5 长按初始化异常：${err.message}`, { code: 'HOTKEY_SETUP' }, { recoverable: true }));
      // Give setup a brief chance to report obvious failures, but never block on
      // the user dialog.
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
    async stop() {
      stopped = true;
      detector.cancel();
      stopRecheck();
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      for (const off of unsubscribers) { try { off(); } catch { /* ignore */ } }
      unsubscribers = [];
      if (conn) {
        try { conn.close(); } catch { /* ignore */ }
        conn = null;
      }
      setState('stopped');
    },
  };
}

export default { createHotkey, createLongPressDetector, ensureDesktopEntry, desktopEntryPath, APP_ID, SHORTCUT_ID };
