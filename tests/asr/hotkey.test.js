// F5 long-press tests. Pure logic + a fake D-Bus portal connection, so the
// real KDE dialog is never involved (that part is manual acceptance, see
// scripts/asr-hotkey-test.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createLongPressDetector,
  createHotkey,
  ensureDesktopEntry,
  desktopEntryPath,
  APP_ID,
  SHORTCUT_ID,
} from '../../src/voice/asr/hotkey.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('long press: a tap shorter than longPressMs does not wake', async () => {
  const wake = [];
  const taps = [];
  const d = createLongPressDetector({
    longPressMs: 60,
    onLongPress: () => wake.push('wake'),
    onTap: (info) => taps.push(info),
  });
  d.press();
  await sleep(20);
  d.release();
  await sleep(80);
  assert.deepEqual(wake, []);
  assert.equal(taps.length, 1);
  assert.ok(taps[0].heldMs < 60);
});

test('long press: holding past the threshold wakes and release ends capture', async () => {
  const wake = [];
  const ends = [];
  const d = createLongPressDetector({
    longPressMs: 50,
    onLongPress: () => wake.push(Date.now()),
    onRelease: (info) => ends.push(info),
  });
  d.press();
  await sleep(120);
  assert.equal(wake.length, 1, 'wake fires at the threshold while still held');
  assert.equal(ends.length, 0, 'no end before release');
  d.release();
  assert.equal(ends.length, 1);
  assert.ok(ends[0].heldMs >= 50);
});

test('long press: duplicate Activated (key auto-repeat) is ignored', async () => {
  let wakeCount = 0;
  const d = createLongPressDetector({ longPressMs: 40, onLongPress: () => { wakeCount++; } });
  d.press();
  d.press();
  d.press();
  await sleep(80);
  d.release();
  assert.equal(wakeCount, 1);
});

test('ensureDesktopEntry writes a valid portal app-id .desktop file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'figaro-xdg-data-'));
  const old = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = tmp;
  try {
    const first = ensureDesktopEntry();
    assert.ok(first.created);
    assert.equal(first.path, desktopEntryPath());
    const content = fs.readFileSync(first.path, 'utf8');
    assert.match(content, /^\[Desktop Entry\]/m);
    assert.match(content, /^Name=Figaro$/m);
    assert.match(content, /^Type=Application$/m);
    const second = ensureDesktopEntry();
    assert.equal(second.created, false, 'idempotent');
    assert.equal(path.basename(first.path), `${APP_ID}.desktop`);
  } finally {
    if (old === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = old;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function fakePortal({ bindShortcuts } = {}) {
  const handlers = [];
  const calls = [];
  const state = {
    // what BindShortcuts returns; tests may mutate this before ShortcutsChanged
    shortcuts: bindShortcuts ?? [
      { id: SHORTCUT_ID, description: '按住说话', trigger: 'F5' },
    ],
  };
  const toVariantList = (list) => [['shortcuts', {
    signature: 'a(sa{sv})',
    value: list.map((s) => [s.id, [
      ['description', { signature: 's', value: s.description }],
      ['trigger_description', { signature: 's', value: s.trigger }],
    ]]),
  }]];
  const emit = (iface, member, sigPath, args) => {
    for (const h of [...handlers]) {
      if (h.interface !== iface || h.member !== member) continue;
      h.fn({ path: sigPath, sender: ':1.1', args });
    }
  };
  let seq = 0;
  const conn = {
    uniqueName: ':1.4242',
    closed: false,
    onSignal({ interface: iface, member, path: filterPath }, fn) {
      const h = { interface: iface, member, path: filterPath, fn };
      handlers.push(h);
      return () => {
        const idx = handlers.indexOf(h);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    async addMatch() {},
    async call(opts) {
      calls.push(opts.member);
      seq += 1;
      if (opts.member === 'Register') return [];
      if (opts.member === 'CreateSession') {
        const reqPath = `/org/freedesktop/portal/desktop/request/1_4242/figaro${seq}`;
        setImmediate(() => emit('org.freedesktop.portal.Request', 'Response', reqPath, [
          0,
          [['session_handle', { signature: 's', value: '/org/freedesktop/portal/desktop/session/1_4242/figaro1' }]],
        ]));
        return [reqPath];
      }
      if (opts.member === 'BindShortcuts') {
        const reqPath = `/org/freedesktop/portal/desktop/request/1_4242/bind${seq}`;
        assert.equal(opts.signature, 'oa(sa{sv})sa{sv}');
        setImmediate(() => emit('org.freedesktop.portal.Request', 'Response', reqPath, [0, toVariantList(state.shortcuts)]));
        return [reqPath];
      }
      if (opts.member === 'ListShortcuts') {
        assert.equal(opts.signature, 'oa{sv}');
        const reqPath = `/org/freedesktop/portal/desktop/request/1_4242/list${seq}`;
        setImmediate(() => emit('org.freedesktop.portal.Request', 'Response', reqPath, [0, toVariantList(state.shortcuts)]));
        return [reqPath];
      }
      throw new Error(`unexpected portal call: ${opts.member}`);
    },
    close() { this.closed = true; },
  };
  return {
    conn,
    emit,
    calls,
    state,
    emitShortcutsChanged(sessionPath) {
      emit('org.freedesktop.portal.GlobalShortcuts', 'ShortcutsChanged', sessionPath, [sessionPath, []]);
    },
  };
}

test('hotkey module: binds via portal and turns Activated/Deactivated into wake/end', async () => {
  const { conn, emit, calls } = fakePortal();
  const events = [];
  const hotkey = createHotkey({
    config: { asr: { hotkey: 'F5', longPressMs: 50 } },
    onWake: () => events.push(['wake', Date.now()]),
    onEnd: () => events.push(['end', Date.now()]),
    onError: (err) => events.push(['error', err.message]),
    onLog: () => {},
    onState: (state) => events.push(['state', state]),
    connectFn: async () => conn,
    bindTimeoutMs: 0,
  });
  try {
    await hotkey.start();
    const t0 = Date.now();
    while (hotkey.state !== 'bound' && Date.now() - t0 < 2000) await sleep(10);
    assert.equal(hotkey.state, 'bound');
    assert.deepEqual(calls, ['Register', 'CreateSession', 'BindShortcuts']);

    const session = hotkey.sessionPath;
    // short tap: below longPressMs -> ignored
    emit('org.freedesktop.portal.GlobalShortcuts', 'Activated', session, [session, SHORTCUT_ID, 100000, []]);
    await sleep(15);
    emit('org.freedesktop.portal.GlobalShortcuts', 'Deactivated', session, [session, SHORTCUT_ID, 100015, []]);
    await sleep(80);
    assert.equal(events.filter(([k]) => k === 'wake').length, 0, 'short tap must not wake');

    // long press: hold > longPressMs -> wake; release -> end
    emit('org.freedesktop.portal.GlobalShortcuts', 'Activated', session, [session, SHORTCUT_ID, 200000, []]);
    await sleep(120);
    assert.equal(events.filter(([k]) => k === 'wake').length, 1, 'long press wakes');
    assert.equal(events.filter(([k]) => k === 'end').length, 0, 'release not seen yet');
    emit('org.freedesktop.portal.GlobalShortcuts', 'Deactivated', session, [session, SHORTCUT_ID, 200120, []]);
    await sleep(30);
    assert.equal(events.filter(([k]) => k === 'end').length, 1, 'release ends capture');
  } finally {
    await hotkey.stop();
  }
  assert.equal(hotkey.state, 'stopped');
  assert.ok(conn.closed, 'D-Bus connection closed on stop');
});

test('hotkey module: signals from another session/shortcut are ignored', async () => {
  const { conn, emit } = fakePortal();
  const events = [];
  const hotkey = createHotkey({
    config: { asr: { hotkey: 'F5', longPressMs: 30 } },
    onWake: () => events.push('wake'),
    onError: () => {},
    onLog: () => {},
    connectFn: async () => conn,
  });
  try {
    await hotkey.start();
    const t0 = Date.now();
    while (hotkey.state !== 'bound' && Date.now() - t0 < 2000) await sleep(10);
    emit('org.freedesktop.portal.GlobalShortcuts', 'Activated', '/other/session', ['/other/session', SHORTCUT_ID, 1, []]);
    emit('org.freedesktop.portal.GlobalShortcuts', 'Activated', hotkey.sessionPath, [hotkey.sessionPath, 'other-shortcut', 2, []]);
    await sleep(80);
    assert.deepEqual(events, []);
  } finally {
    await hotkey.stop();
  }
});

test('hotkey module: recovers when the binding appears after start (no restart needed)', async () => {
  // Portal returns an empty shortcut list at startup (user not approved yet),
  // then the user clicks allow / binds in System Settings: ShortcutsChanged +
  // ListShortcuts must flip the module to 'bound'.
  const fake = fakePortal({ bindShortcuts: [] });
  const events = [];
  const hotkey = createHotkey({
    config: { asr: { hotkey: 'F5', longPressMs: 30 } },
    onWake: () => events.push('wake'),
    onError: (err) => events.push(`error:${err.message}`),
    onLog: () => {},
    onState: (state) => events.push(`state:${state}`),
    connectFn: async () => fake.conn,
    recheckIntervalMs: 60000, // only the signal triggers the refresh in this test
    bindTimeoutMs: 2000,
  });
  try {
    await hotkey.start();
    await sleep(100);
    assert.equal(hotkey.state, 'denied', 'startup: bound but no shortcut yet');
    // user approves later
    fake.state.shortcuts = [{ id: SHORTCUT_ID, description: '按住说话', trigger: 'F5' }];
    fake.emitShortcutsChanged(hotkey.sessionPath);
    const t0 = Date.now();
    while (hotkey.state !== 'bound' && Date.now() - t0 < 2000) await sleep(10);
    assert.equal(hotkey.state, 'bound', 'binding must be picked up without restarting');
    assert.ok(fake.calls.includes('ListShortcuts'));
    // and the long press now works
    fake.emit('org.freedesktop.portal.GlobalShortcuts', 'Activated', hotkey.sessionPath, [hotkey.sessionPath, SHORTCUT_ID, 1, []]);
    await sleep(80);
    assert.deepEqual(events.filter((e) => e === 'wake'), ['wake']);
  } finally {
    await hotkey.stop();
  }
});

test('hotkey module: user cancel is reported as a non-fatal error', async () => {
  const handlers = [];
  const conn = {
    uniqueName: ':1.5',
    closed: false,
    onSignal({ interface: iface, member }, fn) {
      const h = { iface, member, fn };
      handlers.push(h);
      return () => {
        const i = handlers.indexOf(h);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    async addMatch() {},
    async call(opts) {
      if (opts.member === 'Register') return [];
      if (opts.member === 'CreateSession' || opts.member === 'BindShortcuts') {
        const reqPath = `/req/${opts.member}`;
        setImmediate(() => {
          for (const h of [...handlers]) {
            if (h.iface !== 'org.freedesktop.portal.Request' || h.member !== 'Response') continue;
            h.fn({ path: reqPath, args: [1, []] }); // 1 = cancelled
          }
        });
        return [reqPath];
      }
      return [];
    },
    close() { this.closed = true; },
  };
  const errors = [];
  const hotkey = createHotkey({
    config: { asr: { hotkey: 'F5', longPressMs: 30 } },
    onWake: () => {},
    onError: (err) => errors.push(err.message),
    onLog: () => {},
    connectFn: async () => conn,
    bindTimeoutMs: 500,
  });
  try {
    await hotkey.start();
    const t0 = Date.now();
    while (hotkey.state !== 'unavailable' && Date.now() - t0 < 2000) await sleep(10);
    assert.equal(hotkey.state, 'unavailable');
    assert.ok(errors.length >= 1);
    assert.match(errors.join('\n'), /会话|创建|拒绝|cancel/i);
  } finally {
    await hotkey.stop();
  }
});
