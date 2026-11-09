// D-Bus wire-protocol tests.
//
// 1. Pure codec round-trips (always run, no bus needed).
// 2. Live session-bus handshake + portal method call (skipped when no bus).

import test from 'node:test';
import assert from 'node:assert/strict';

import { marshalBody, unmarshalBody, splitSignature, variant, connect } from '../../src/voice/asr/dbus.js';

test('splitSignature parses complete D-Bus types', () => {
  assert.deepEqual(splitSignature('sa{sv}'), ['s', 'a{sv}']);
  assert.deepEqual(splitSignature('oa(sa{sv})sa{sv}'), ['o', 'a(sa{sv})', 's', 'a{sv}']);
  assert.deepEqual(splitSignature('ua{sv}'), ['u', 'a{sv}']);
  assert.deepEqual(splitSignature(''), []);
  assert.throws(() => splitSignature('a'), /bad signature|unsupported/);
});

test('marshal/unmarshal round-trips the signatures used by the portal', () => {
  const cases = [
    ['s', ['hello']],
    ['u', [42]],
    ['t', [1234567890123]],
    ['ss', ['a', 'b']],
    ['a{sv}', [[
      ['handle_token', variant('s', 'tok1')],
      ['session_handle_token', variant('s', 'tok2')],
    ]]],
    ['a(sa{sv})', [[
      ['figaro-talk', [
        ['description', variant('s', '按住说话')],
        ['preferred_trigger', variant('s', 'F5')],
      ]],
    ]]],
    ['oa(sa{sv})sa{sv}', [
      '/org/freedesktop/portal/desktop/session/1_1/figaro',
      [['figaro-talk', [['description', variant('s', 'talk')]]]],
      '',
      [['handle_token', variant('s', 'bind1')]],
    ]],
    ['ua{sv}', [0, [['session_handle', variant('s', '/s/1')]]]],
  ];
  for (const [sig, values] of cases) {
    const wire = marshalBody(sig, values);
    const decoded = unmarshalBody(wire, sig);
    assert.deepEqual(decoded, values, `round-trip failed for ${sig}`);
  }
});

test('variants preserve their inner signature', () => {
  const [decoded] = unmarshalBody(marshalBody('a{sv}', [[['n', variant('u', 7)]]]), 'a{sv}');
  assert.deepEqual(decoded, [['n', { signature: 'u', value: 7 }]]);
});

test('live session bus: handshake, GetId, portal owner, AddMatch', async (t) => {
  let conn;
  try {
    conn = await connect({ callTimeoutMs: 4000 });
  } catch (err) {
    t.skip(`D-Bus session bus unavailable: ${err.message}`);
    return;
  }
  try {
    assert.match(conn.uniqueName, /^:\d+\.\d+$/);
    const dbus = { destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus' };
    const [busId] = await conn.call({ ...dbus, member: 'GetId' });
    assert.match(busId, /^[0-9a-f]{32}$/);
    const [names] = await conn.call({ ...dbus, member: 'ListNames' });
    assert.ok(Array.isArray(names) && names.includes('org.freedesktop.DBus'));
    await conn.addMatch("type='signal',interface='org.freedesktop.DBus',member='NameOwnerChanged'");
  } finally {
    conn.close();
  }
});

test('live portal: a{sv} method call reaches xdg-desktop-portal (app-id validation)', async (t) => {
  let conn;
  try {
    conn = await connect({ callTimeoutMs: 6000 });
  } catch (err) {
    t.skip(`D-Bus session bus unavailable: ${err.message}`);
    return;
  }
  try {
    const [names] = await conn.call({
      destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus', member: 'ListNames',
    });
    if (!names.includes('org.freedesktop.portal.Desktop')) {
      t.skip('xdg-desktop-portal is not running');
      return;
    }
    // CreateSession marshals an a{sv} and requires a registered host app id when
    // called without Register(); either outcome proves the codec + routing work.
    try {
      const reply = await conn.call({
        destination: 'org.freedesktop.portal.Desktop',
        path: '/org/freedesktop/portal/desktop',
        interface: 'org.freedesktop.portal.GlobalShortcuts',
        member: 'CreateSession',
        signature: 'a{sv}',
        body: [{
          handle_token: variant('s', `figaro-test-${process.pid}`),
          session_handle_token: variant('s', `figaro-test-${process.pid}`),
        }],
        timeoutMs: 5000,
      });
      assert.ok(typeof reply[0] === 'string' && reply[0].startsWith('/'));
    } catch (err) {
      assert.match(err.message, /app id|NotAllowed|portal/i, `unexpected portal error: ${err.message}`);
    }
  } finally {
    conn.close();
  }
});
