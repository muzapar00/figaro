// `home` tool tests: Home Assistant is mocked with node:http, so the suite needs
// no real HA, no devices and no network. The mock intentionally echoes the
// Authorization header on error pages so the "never leak the token" behaviour is
// exercised for real, not just assumed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHomeTool } from '../../src/agent/tools/home.js';
import { parametersToJsonSchema } from '../../src/agent/tools/define.js';

const TOKEN = 'test-ha-token-0123456789abcdef';

function baseLights() {
  return {
    'light.bedroom_lamp': {
      entity_id: 'light.bedroom_lamp',
      state: 'off',
      attributes: {
        friendly_name: '卧室台灯',
        supported_color_modes: ['color_temp'],
        min_color_temp_kelvin: 2700,
        max_color_temp_kelvin: 6500,
        brightness: 0,
      },
    },
    'light.living_room_lamp': {
      entity_id: 'light.living_room_lamp',
      state: 'off',
      attributes: {
        friendly_name: '客厅台灯',
        supported_color_modes: ['color_temp'],
        min_color_temp_kelvin: 2700,
        max_color_temp_kelvin: 6500,
        brightness: 0,
      },
    },
    'light.desk_strip': {
      entity_id: 'light.desk_strip',
      state: 'off',
      attributes: { friendly_name: '书桌灯带', supported_color_modes: ['onoff'] },
    },
    'switch.kettle': {
      entity_id: 'switch.kettle',
      state: 'off',
      attributes: { friendly_name: '电水壶' },
    },
    'sensor.room_temperature': {
      entity_id: 'sensor.room_temperature',
      state: '24.5',
      attributes: { friendly_name: '室温', unit_of_measurement: '°C' },
    },
  };
}

function authHeader() {
  return `Bearer ${TOKEN}`;
}

/**
 * Start a tiny HA REST mock.
 * Options: delayMs (delays GET /api/states), extraStates.
 */
async function startMockHa(t, { delayMs = 0, extraStates = {} } = {}) {
  const lights = { ...baseLights(), ...extraStates };
  const calls = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const authorized = req.headers.authorization === authHeader();
      if (!authorized) {
        // Echo the received header on purpose: the tool must never copy the
        // response body into a model-visible string.
        return send(401, { message: `Unauthorized: ${req.headers.authorization ?? '(none)'}` });
      }

      if (req.method === 'GET' && url.pathname === '/api/states') {
        const reply = () => send(200, Object.values(lights));
        return delayMs > 0 ? setTimeout(reply, delayMs) : reply();
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/states/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/states/'.length));
        return lights[id] ? send(200, lights[id]) : send(404, { message: 'Entity not found.' });
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/services/light/')) {
        const service = url.pathname.slice('/api/services/light/'.length);
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { return send(400, { message: 'bad json' }); }
        calls.push({ service, body: payload, authorization: req.headers.authorization });
        const light = lights[payload.entity_id];
        if (!light) return send(400, { message: 'Entity not found.' });
        if (service === 'turn_on') {
          light.state = 'on';
          if (typeof payload.brightness_pct === 'number') {
            light.attributes.brightness = Math.max(1, Math.round((payload.brightness_pct / 100) * 255));
          } else if (!light.attributes.brightness) {
            light.attributes.brightness = 255;
          }
          if (typeof payload.color_temp_kelvin === 'number') {
            light.attributes.color_temp_kelvin = payload.color_temp_kelvin;
          }
        } else if (service === 'turn_off') {
          light.state = 'off';
        } else {
          return send(400, { message: `unsupported service ${service}` });
        }
        return send(200, [light]);
      }

      return send(404, { message: 'Not found' });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, calls, lights };
}

function makeTool(server, overrides = {}) {
  return createHomeTool({
    config: {
      home: {
        haUrl: server.url,
        haToken: TOKEN,
        ...overrides.config,
      },
    },
    ...overrides.options,
  });
}

function assertNoToken(result) {
  const text = typeof result === 'string' ? result : String(result?.content ?? '');
  assert.doesNotMatch(text, new RegExp(TOKEN), 'tool output must never contain the HA token');
  assert.doesNotMatch(text, /Bearer\s+(?!\[redacted\])/i, 'tool output must never contain a bearer header');
}

test('list reports lights (friendly_name + entity id) and ignores non-light entities', async (t) => {
  const server = await startMockHa(t);
  const tool = makeTool(server);
  const result = await tool.execute({ action: 'list' });
  assert.match(result.content, /卧室台灯/);
  assert.match(result.content, /客厅台灯/);
  assert.match(result.content, /书桌灯带/);
  assert.match(result.content, /light\.bedroom_lamp/);
  assert.doesNotMatch(result.content, /电水壶|switch\.kettle|室温/);
  assertNoToken(result);
});

test('switches a light on by its spoken name', async (t) => {
  const server = await startMockHa(t);
  const tool = makeTool(server);
  const result = await tool.execute({ action: 'on', device: '卧室台灯' });
  assert.match(result.content, /好，卧室台灯开着/);
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].service, 'turn_on');
  assert.equal(server.calls[0].body.entity_id, 'light.bedroom_lamp');
  assert.equal(server.calls[0].authorization, authHeader());
  assertNoToken(result);
});

test('fuzzy alias ("卧室灯") resolves to the bedroom lamp', async (t) => {
  const server = await startMockHa(t);
  const tool = makeTool(server);
  const result = await tool.execute({ action: 'on', device: '卧室灯' });
  assert.match(result.content, /卧室台灯/);
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].body.entity_id, 'light.bedroom_lamp');
  assertNoToken(result);
});

test('ambiguous device names return candidates and do not call the service', async (t) => {
  const server = await startMockHa(t);
  const tool = makeTool(server);
  const result = await tool.execute({ action: 'on', device: '台灯' });
  assert.match(result.content, /可能的设备/);
  assert.match(result.content, /卧室台灯/);
  assert.match(result.content, /客厅台灯/);
  assert.match(result.content, /哪个/);
  assert.equal(server.calls.length, 0);
  assertNoToken(result);
});

test('401 turns into a spoken authorization message and never leaks the token', async (t) => {
  const server = await startMockHa(t);
  const badToken = 'bad-token-should-not-leak';
  const tool = createHomeTool({
    config: { home: { haUrl: server.url, haToken: badToken } },
  });
  const result = await tool.execute({ action: 'list' });
  assert.match(result.content, /授权不对/);
  assert.match(result.content, /重新配置令牌/);
  assert.doesNotMatch(result.content, /bad-token-should-not-leak/);
  assertNoToken(result);
});

test('timeout turns into a spoken timeout message (no throw, no token)', async (t) => {
  const server = await startMockHa(t, { delayMs: 400 });
  const tool = makeTool(server, { options: { timeoutMs: 80 } });
  const result = await tool.execute({ action: 'on', device: '卧室台灯' });
  assert.match(result.content, /超时/);
  assert.equal(server.calls.length, 0);
  assertNoToken(result);
});

test('unknown device lists the available lights instead of guessing', async (t) => {
  const server = await startMockHa(t);
  const tool = makeTool(server);
  const result = await tool.execute({ action: 'on', device: '厨房灯' });
  assert.match(result.content, /没找到/);
  assert.match(result.content, /卧室台灯/);
  assert.equal(server.calls.length, 0);
  assertNoToken(result);
});

test('brightness sends brightness_pct and reports the observed state', async (t) => {
  const server = await startMockHa(t);
  const tool = makeTool(server);
  const result = await tool.execute({ action: 'brightness', device: '卧室台灯', value: 40 });
  assert.match(result.content, /亮度百分之40/);
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].service, 'turn_on');
  assert.equal(server.calls[0].body.brightness_pct, 40);
  assertNoToken(result);
});

test('color temperature is sent as color_temp_kelvin and clamped to the device range', async (t) => {
  const server = await startMockHa(t);
  const tool = makeTool(server);
  const result = await tool.execute({ action: 'color_temp', device: '卧室台灯', kelvin: 3000 });
  assert.match(result.content, /3000K/);
  assert.equal(server.calls[0].body.color_temp_kelvin, 3000);
  assertNoToken(result);

  const low = await tool.execute({ action: 'color_temp', device: '卧室台灯', kelvin: 1000 });
  assert.equal(server.calls[1].body.color_temp_kelvin, 2700);
  assert.match(low.content, /2700K/);
});

test('a light without color temperature reports its real capabilities', async (t) => {
  const server = await startMockHa(t);
  const tool = makeTool(server);
  const result = await tool.execute({ action: 'color_temp', device: '书桌灯带', kelvin: 3000 });
  assert.match(result.content, /不支持调色温/);
  assert.match(result.content, /开关/);
  assert.equal(server.calls.length, 0);
  assertNoToken(result);
});

test('state reads without calling any service', async (t) => {
  const server = await startMockHa(t);
  const tool = makeTool(server);
  const result = await tool.execute({ action: 'state', device: '卧室台灯' });
  assert.match(result.content, /关着/);
  assert.equal(server.calls.length, 0);
  assertNoToken(result);
});

test('missing HA configuration is a spoken error, not a crash', async () => {
  const tool = createHomeTool({ config: {} });
  const result = await tool.execute({ action: 'list' });
  assert.match(result.content, /没配置好|还没有配置/);
  assertNoToken(result);
});

test('defaultRoom resolves an otherwise ambiguous "灯" to the room lamp', async (t) => {
  const server = await startMockHa(t);
  const tool = makeTool(server, { config: { defaultRoom: '卧室' } });
  const result = await tool.execute({ action: 'on', device: '灯' });
  assert.match(result.content, /卧室台灯/);
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].body.entity_id, 'light.bedroom_lamp');
  assertNoToken(result);
});

test('schema is dsh-style and converts to a real JSON Schema', () => {
  const tool = createHomeTool({ config: {} });
  assert.equal(tool.name, 'home');
  assert.equal(tool.parameters.action.required, true);
  assert.deepEqual(tool.parameters.action.enum, ['list', 'state', 'on', 'off', 'brightness', 'color_temp']);
  assert.equal(tool.parameters.value.type, 'number');
  assert.equal(tool.parameters.kelvin.type, 'number');

  const schema = parametersToJsonSchema(tool.parameters);
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['action']);
  assert.deepEqual(schema.properties.action.enum, ['list', 'state', 'on', 'off', 'brightness', 'color_temp']);
  assert.equal(schema.additionalProperties, false);
  assert.match(tool.description, /Home Assistant/);
});

test('prefix match beats a longer name that merely contains the word', async () => {
  const server = http.createServer((req, res) => {
    const body = JSON.stringify([
      { entity_id: 'light.pro_lamp', state: 'off', attributes: { friendly_name: '米家台灯Pro  灯' } },
      { entity_id: 'light.main_lamp', state: 'on', attributes: { friendly_name: '台灯  Light' } },
    ]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.method === 'GET') res.end(body);
    else { res.writeHead(200); res.end('[]'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const tool = createHomeTool({ config: { home: { haUrl: `http://127.0.0.1:${port}`, haToken: 'x' } } });
    const result = await tool.execute({ action: 'state', device: '台灯' });
    assert.match(result.content, /台灯\s+Light/, 'the lamp whose name starts with 台灯 wins');
    assert.doesNotMatch(result.content, /米家台灯Pro/, 'no ambiguity with the Pro lamp');
  } finally {
    server.close();
  }
});

test('unavailable lights are not listed or offered as candidates', async () => {
  const server = http.createServer((req, res) => {
    const body = JSON.stringify([
      { entity_id: 'light.real', state: 'on', attributes: { friendly_name: '台灯' } },
      { entity_id: 'light.gone', state: 'unavailable', attributes: { friendly_name: '鱼缸灯' } },
    ]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.method === 'GET') res.end(body);
    else { res.writeHead(200); res.end('[]'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const tool = createHomeTool({ config: { home: { haUrl: `http://127.0.0.1:${port}`, haToken: 'x' } } });
    const list = await tool.execute({ action: 'list' });
    assert.match(list.content, /台灯/);
    assert.doesNotMatch(list.content, /鱼缸灯/);
    const state = await tool.execute({ action: 'state', device: '鱼缸灯' });
    assert.doesNotMatch(state.content, /鱼缸灯（light.gone）/);
  } finally {
    server.close();
  }
});
