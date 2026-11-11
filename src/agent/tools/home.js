// Smart-home tool: control lights through a local Home Assistant.
//
// Figaro does not speak HomeKit / miIO itself. Home Assistant is the device
// layer (HomeKit Device integration for the desk lamp, later Xiaomi devices
// through their own integrations); this tool only maps what the user said to
// one HA entity and one HA service call, over the documented REST API:
//
//   GET  /api/states                         -> list every entity
//   POST /api/services/light/turn_on         -> {entity_id, brightness_pct?, color_temp_kelvin?}
//   POST /api/services/light/turn_off        -> {entity_id}
//
// The token lives in `config.home.haToken` and is used only in the
// Authorization header. It must never end up in a model-visible string, so
// every returned line goes through redact() and we never echo response bodies
// from failed requests.
import { defineTool } from './define.js';

const DEFAULT_TIMEOUT_MS = 4000;
const TOOL_TIMEOUT_MS = 8000;
const DEFAULT_COLOR_TEMP_RANGE = [2700, 6500];
const MAX_CANDIDATES_IN_REPLY = 3;
const MAX_LISTED_LIGHTS = 20;

// Only these entity domains are exposed: turning a lamp on/off is the scope of
// this tool. Locks, covers, cameras, alarms and scripts stay unreachable even
// if HA has them.
const LIGHT_DOMAIN = 'light.';
const LIGHT_SERVICE_PATH = '/api/services/light';

/** Normalize Chinese/English device words for loose matching ("卧 室_灯" -> "卧室灯"). */
function normalize(text) {
  return String(text ?? '').trim().toLowerCase().replace(/[\s_\-·.]/g, '');
}

/** How many of `query`'s characters appear in `name` (order ignored). 0..1. */
function charCoverage(query, name) {
  const q = normalize(query);
  const n = normalize(name);
  if (q.length === 0 || n.length === 0) return 0;
  const pool = [...n];
  let hit = 0;
  for (const ch of q) {
    const index = pool.indexOf(ch);
    if (index >= 0) {
      hit += 1;
      pool.splice(index, 1);
    }
  }
  return hit / q.length;
}

function lightName(light) {
  return String(light.attributes?.friendly_name || light.entity_id);
}

/** An unavailable entity cannot be controlled; keep it out of candidates. */
function isAvailable(light) {
  return light && light.state !== 'unavailable' && light.state !== 'unknown';
}

/** Score a light against a spoken device name: exact > substring > character overlap. */
function scoreLight(light, query) {
  const q = normalize(query);
  if (q.length === 0) return 0;
  const name = normalize(lightName(light));
  const slug = normalize(light.entity_id.slice(LIGHT_DOMAIN.length));
  if (name === q || slug === q) return 1.2;
  // Prefix hits are what a person means by "台灯": the lamp called 台灯 Light
  // wins over 米家台灯Pro even though both contain the characters.
  if (name.startsWith(q)) return 1.1;
  if (name.includes(q) || q.includes(name)) return 1;
  if (slug.includes(q)) return 0.9;
  if (q.length >= 2) {
    const nameCoverage = charCoverage(q, name);
    if (nameCoverage >= 0.8) return 0.8;
    const slugCoverage = charCoverage(q, slug);
    if (slugCoverage >= 0.8) return 0.7;
  } else if (name.includes(q)) {
    // A single character such as "灯" is allowed to match, but it will usually
    // hit several lights and come back as an ambiguity question.
    return 0.5;
  }
  return 0;
}

function inRoom(light, room) {
  const wanted = normalize(room);
  if (wanted.length === 0) return true;
  return normalize(lightName(light)).includes(wanted)
    || normalize(light.entity_id).includes(wanted);
}

/**
 * Resolve a spoken device to one light.
 * @returns {{light: object}|{candidates: object[]}|null}
 */
function resolveLight(lights, { device, room, defaultRoom }) {
  const wantedRoom = room || defaultRoom || '';
  const wantedDevice = device || '';

  if (wantedDevice) {
    let scored = lights
      .map((light) => ({ light, score: scoreLight(light, wantedDevice) }))
      .filter((entry) => entry.score > 0);
    // An explicit room is a hard filter, but a configured defaultRoom must not
    // win over words the user actually said ("把客厅灯关掉" with default 卧室).
    if (room) scored = scored.filter((entry) => inRoom(entry.light, room));
    if (scored.length === 0) return null;
    const best = Math.max(...scored.map((entry) => entry.score));
    let top = scored.filter((entry) => Math.abs(entry.score - best) < 0.05).map((entry) => entry.light);
    if (top.length > 1 && defaultRoom) {
      // "把灯关掉" with a configured default room should not ask one more time.
      const inDefault = top.filter((light) => inRoom(light, defaultRoom));
      if (inDefault.length === 1) top = inDefault;
    }
    if (top.length === 1) return { light: top[0] };
    return { candidates: top };
  }

  // No device word: a room can still narrow the choice (list/status use this).
  const inWantedRoom = wantedRoom ? lights.filter((light) => inRoom(light, wantedRoom)) : lights;
  if (inWantedRoom.length === 0) return null;
  if (inWantedRoom.length === 1) return { light: inWantedRoom[0] };
  return { candidates: inWantedRoom };
}

function brightnessPercent(attributes) {
  const raw = attributes?.brightness;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(100, Math.round((raw / 255) * 100)));
}

function lightCapabilities(light) {
  const attributes = light.attributes ?? {};
  const modes = Array.isArray(attributes.supported_color_modes) ? attributes.supported_color_modes : [];
  const supportsBrightness = attributes.brightness !== undefined
    || modes.some((mode) => mode !== 'onoff');
  const supportsColorTemp = modes.includes('color_temp')
    || (attributes.min_color_temp_kelvin !== undefined && attributes.max_color_temp_kelvin !== undefined);
  return { supportsBrightness, supportsColorTemp };
}

function capabilitiesText(light) {
  const { supportsBrightness, supportsColorTemp } = lightCapabilities(light);
  const parts = ['开关'];
  if (supportsBrightness) parts.push('调亮度');
  if (supportsColorTemp) parts.push('调色温');
  return parts.join('、');
}

function stripTrailingPeriod(text) {
  return String(text).replace(/[。.!！]+$/u, '');
}

/** One spoken sentence describing the light's current HA state. */
function describeLight(light) {
  const name = lightName(light);
  const attributes = light.attributes ?? {};
  if (light.state === 'on') {
    const parts = ['开着'];
    const percent = brightnessPercent(attributes);
    if (percent !== null) parts.push(`亮度百分之${percent}`);
    if (typeof attributes.color_temp_kelvin === 'number') parts.push(`色温${attributes.color_temp_kelvin}K`);
    return `${name}${parts.join('，')}。`;
  }
  if (light.state === 'off') return `${name}现在是关着的。`;
  return `${name}现在不可用（${light.state}）。`;
}

function listNames(lights, limit = MAX_CANDIDATES_IN_REPLY) {
  const names = lights.slice(0, limit).map((light) => lightName(light));
  const suffix = lights.length > limit ? '等' : '';
  return names.join('、') + suffix;
}

function ambiguousReply(candidates) {
  return `有 ${candidates.length} 个可能的设备：${listNames(candidates)}。你指的是哪个？`;
}

function notFoundReply(query, lights) {
  const what = stripTrailingPeriod(query) || '这个设备';
  if (lights.length === 0) return `我没找到「${what}」，家里现在没有可控制的灯。`;
  return `我没找到「${what}」。现在的灯有：${listNames(lights)}。`;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

class HomeApiError extends Error {
  constructor(kind, status) {
    super(kind);
    this.name = 'HomeApiError';
    this.kind = kind;
    this.status = status;
  }
}

/** Never let the token (or anything that looks like a bearer header) reach the model. */
function redact(text, token) {
  let output = String(text ?? '');
  if (typeof token === 'string' && token.length > 0) {
    output = output.split(token).join('[redacted]');
  }
  return output.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

function apiErrorReply(error) {
  if (error instanceof HomeApiError) {
    if (error.kind === 'timeout') return '家庭中枢响应超时，我没确认到设备状态。';
    if (error.kind === 'network') return '连不上家庭中枢，检查一下地址或网络。';
    if (error.kind === 'badjson') return '家庭中枢返回了无法解析的数据。';
    if (error.kind === 'http') {
      if (error.status === 401 || error.status === 403) return '家庭中枢的授权不对，需要重新配置令牌。';
      if (error.status === 404) return '家庭中枢找不到这个接口，可能版本不对。';
      if (error.status === 503) return '家庭中枢正在启动，稍等一下再说一次。';
      return `家庭中枢出错了（${error.status}），没操作成功。`;
    }
  }
  return '家庭中枢出了点问题，没操作成功。';
}

/**
 * @param {{ config?: object, fetchImpl?: Function, timeoutMs?: number }} [options]
 *   config.home = { haUrl, haToken, defaultRoom? } (token is a secret; never log it)
 */
export function createHomeTool(options = {}) {
  const config = options.config ?? {};
  const home = config.home ?? {};
  const haUrl = typeof home.haUrl === 'string' ? home.haUrl.trim().replace(/\/+$/, '') : '';
  const haToken = typeof home.haToken === 'string' ? home.haToken.trim() : '';
  const defaultRoom = typeof home.defaultRoom === 'string' ? home.defaultRoom.trim() : '';
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const configured = haUrl.length > 0 && haToken.length > 0;

  async function requestJson(path, { method = 'GET', body } = {}) {
    if (typeof fetchImpl !== 'function') throw new HomeApiError('network');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(`${haUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${haToken}`,
            'content-type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          redirect: 'error',
        });
      } catch {
        throw new HomeApiError(controller.signal.aborted ? 'timeout' : 'network');
      }
      // The timer stays armed while the body is read, so a slow body also
      // counts as a timeout instead of hanging the voice turn.
      let text = '';
      try {
        text = await response.text();
      } catch {
        throw new HomeApiError(controller.signal.aborted ? 'timeout' : 'network');
      }
      if (!response.ok) throw new HomeApiError('http', response.status);
      if (text.trim().length === 0) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new HomeApiError('badjson');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchLights() {
    const states = await requestJson('/api/states');
    if (!Array.isArray(states)) throw new HomeApiError('badjson');
    return states.filter((state) => (
      state && typeof state.entity_id === 'string' && state.entity_id.startsWith(LIGHT_DOMAIN)
    ));
  }

  async function fetchLight(entityId) {
    return requestJson(`/api/states/${encodeURIComponent(entityId)}`);
  }

  async function callLightService(service, body) {
    const changed = await requestJson(`${LIGHT_SERVICE_PATH}/${service}`, { method: 'POST', body });
    if (Array.isArray(changed) && changed.length > 0 && changed[0]?.entity_id === body.entity_id) return changed[0];
    // HA normally returns the changed states; fall back to a read so a reply is
    // based on observed state instead of optimism.
    return fetchLight(body.entity_id);
  }

  function describeResult(light) {
    if (!light || typeof light.entity_id !== 'string') return '操作发出去了，但没读到最新状态。';
    return `好，${describeLight(light)}`;
  }

  return defineTool({
    name: 'home',
    description:
      'Control the lights of the user\'s home through the local Home Assistant. '
      + 'Use action=list to find lights, action=state to read one, action=on/off to switch one, '
      + 'action=brightness with value=1..100 to dim or brighten, and action=color_temp with kelvin to change color temperature. '
      + 'Refer to a light by what the user says (客厅台灯/卧室灯), not by entity id; when several lights match, ask the user which one. '
      + 'Lights only are reachable. Report only what the tool returned; never claim a change the tool did not confirm.',
    timeoutMs: TOOL_TIMEOUT_MS,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'state', 'on', 'off', 'brightness', 'color_temp'],
        description: 'What to do: list lights, read one, switch one on/off, set brightness percent, or set color temperature.',
      },
      device: {
        type: 'string',
        description: 'The light as the user calls it, e.g. 台灯 / 卧室灯 / 客厅灯. Fuzzy matching; omit to list or ask.',
      },
      value: {
        type: 'number',
        description: 'Brightness percent, 1-100 (0 turns the light off). Required for action=brightness.',
      },
      kelvin: {
        type: 'number',
        description: 'Color temperature in kelvin, e.g. 2700 (warm) or 5000 (cool). Required for action=color_temp.',
      },
      room: {
        type: 'string',
        description: 'Optional room word to narrow the match (卧室/客厅). HA REST does not expose area ids, so rooms are matched against the device name.',
      },
    },

    async execute(args = {}) {
      const respond = (content) => ({ content: redact(content, haToken) });
      if (!configured) {
        return respond('家庭中枢还没配置好，需要先填 Home Assistant 的地址和令牌。');
      }

      const action = String(args.action ?? '');
      if (!['list', 'state', 'on', 'off', 'brightness', 'color_temp'].includes(action)) {
        return respond('这个操作我还不支持，能做的有：列设备、查状态、开关灯、调亮度、调色温。');
      }

      const requestedValue = numberOrNull(args.value);
      if (action === 'brightness' && (requestedValue === null || requestedValue < 0 || requestedValue > 100)) {
        return respond('亮度要在 1 到 100 之间，你要调到多少？');
      }
      const requestedKelvin = numberOrNull(args.kelvin);
      if (action === 'color_temp' && (requestedKelvin === null || requestedKelvin < 1000 || requestedKelvin > 10000)) {
        return respond('色温要在 1000K 到 10000K 之间，你要调到多少？');
      }

      const device = typeof args.device === 'string' ? args.device.trim() : '';
      const room = typeof args.room === 'string' ? args.room.trim() : '';

      try {
        const lights = (await fetchLights()).filter(isAvailable);

        if (action === 'list') {
          let listed = lights;
          // A configured defaultRoom is a tie-breaker for ambiguous commands;
          // "what lights do I have" should still show everything unless the
          // user explicitly asked for a room.
          if (room) listed = lights.filter((light) => inRoom(light, room));
          if (listed.length === 0) return respond(notFoundReply(room || defaultRoom, lights));
          const shown = listed.slice(0, MAX_LISTED_LIGHTS).map((light) => {
            const name = lightName(light);
            return `${name}（${light.entity_id}）：${light.state === 'on' ? '开着' : light.state === 'off' ? '关着' : light.state}`;
          });
          const suffix = listed.length > MAX_LISTED_LIGHTS ? `，还有 ${listed.length - MAX_LISTED_LIGHTS} 个没列出来` : '';
          return respond(`家里有这些灯：${shown.join('；')}${suffix}。`);
        }

        const resolved = resolveLight(lights, { device, room, defaultRoom });
        if (resolved === null) {
          const query = [room, device].filter(Boolean).join('') || '这个设备';
          const inRoomLights = room ? lights.filter((light) => inRoom(light, room)) : lights;
          return respond(notFoundReply(query, inRoomLights.length > 0 ? inRoomLights : lights));
        }
        if (resolved.candidates) return respond(ambiguousReply(resolved.candidates));

        const light = resolved.light;
        const { supportsBrightness, supportsColorTemp } = lightCapabilities(light);

        if (action === 'state') return respond(describeLight(light));

        if (action === 'brightness' && !supportsBrightness) {
          return respond(`这台${lightName(light)}不支持调亮度，能做的有：${capabilitiesText(light)}。`);
        }
        if (action === 'color_temp' && !supportsColorTemp) {
          return respond(`这台${lightName(light)}不支持调色温，能做的有：${capabilitiesText(light)}。`);
        }

        let next;
        if (action === 'on') {
          next = await callLightService('turn_on', { entity_id: light.entity_id });
        } else if (action === 'off') {
          next = await callLightService('turn_off', { entity_id: light.entity_id });
        } else if (action === 'brightness') {
          if (requestedValue === 0) {
            next = await callLightService('turn_off', { entity_id: light.entity_id });
          } else {
            next = await callLightService('turn_on', {
              entity_id: light.entity_id,
              brightness_pct: Math.round(requestedValue),
            });
          }
        } else {
          const attributes = light.attributes ?? {};
          const minKelvin = numberOrNull(attributes.min_color_temp_kelvin) ?? DEFAULT_COLOR_TEMP_RANGE[0];
          const maxKelvin = numberOrNull(attributes.max_color_temp_kelvin) ?? DEFAULT_COLOR_TEMP_RANGE[1];
          const kelvin = Math.min(maxKelvin, Math.max(minKelvin, Math.round(requestedKelvin)));
          next = await callLightService('turn_on', { entity_id: light.entity_id, color_temp_kelvin: kelvin });
        }

        return respond(describeResult(next));
      } catch (error) {
        return respond(apiErrorReply(error));
      }
    },
  });
}
