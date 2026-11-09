#!/usr/bin/env node
// Generate a "near-miss" negative corpus for wake-word specificity testing.
//
//   node scripts/gen-wake-negative-audio.mjs          # generate missing clips
//   node scripts/gen-wake-negative-audio.mjs --force
//
// These sentences deliberately contain 费/非/飞/菲 + 加/家/佳/嘉 sounds (and
// other voice assistants' wake words) but must NEVER wake Figaro. They are the
// adversarial set used by scripts/asr-wake-sensitivity.mjs.
//
// Output: models/wake-negatives/*.wav + manifest.json (models/ is git-ignored).
// The MiniMax key is read from ~/.config/figaro/config.json and never printed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'models', 'wake-negatives');
const CONFIG_PATH = path.join(process.env.HOME, '.config', 'figaro', 'config.json');
const VOICES = ['male-qn-jingying', 'female-shaonv', 'male-qn-qingse', 'female-tianmei'];

const SENTENCES = [
  '飞机马上就要起飞了',
  '非常抱歉我来晚了',
  '今天的费用已经结算了',
  '我今晚要加班到十点',
  '加油你一定可以的',
  '他家里人都不太同意',
  '大家安静一下',
  '国家政策有新的变化',
  '非法加班是不允许的',
  '飞机加满油需要多久',
  '这次非常加急要今天完成',
  '我们坐飞机去加拿大',
  '非加强管理不可',
  '费用加起来一共三百块',
  '费先生和加女士到了吗',
  '菲姐家孩子考上大学了',
  '飞往巴黎的航班延误了',
  '你给我飞一个看看',
  '这个费用高得离谱',
  '加个微信吧',
  '麻烦加一下我的好友',
  '谁的加班最多',
  '小爱同学关灯',
  '天猫精灵播放音乐',
  '嘿Siri今天天气怎么样',
  '小度小度',
  '播放费玉清的歌曲',
  '加菲猫电影真好看',
  '咖啡加糖谢谢',
  '明天要涨价加薪了',
  '房价加息影响很大',
  '暑假加班太累了',
  '缴费加紧办理一下',
  '飞机上的饭不好吃',
  '非常加油的一次比赛',
  '这家店的费用不贵',
  '他把文件加了个密码',
  '非法集资要小心',
  '飞哥家里有事',
  '费用增加了一倍',
];

const args = process.argv.slice(2);
const FORCE = args.includes('--force');

function loadKey() {
  if (process.env.FIGARO_MINIMAX_API_KEY) return process.env.FIGARO_MINIMAX_API_KEY;
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!cfg.minimax?.apiKey) throw new Error('no minimax.apiKey');
  return cfg.minimax.apiKey;
}
function wavInfo(buf) {
  let off = 12, fmt = null, dataBytes = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    else if (id === 'data') dataBytes = size;
    off = body + size + (size % 2);
  }
  return { ...fmt, durationMs: Math.round((dataBytes / ((fmt.channels * fmt.bits) / 8) / fmt.sampleRate) * 1000) };
}
async function synth(key, text, voice, speed = 1.0) {
  const body = {
    model: 'speech-02-turbo', text, stream: false,
    voice_setting: { voice_id: voice, speed, vol: 1.0, pitch: 0 },
    audio_setting: { sample_rate: 16000, bitrate: 128000, format: 'wav', channel: 1 },
  };
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch('https://api.minimax.cn/v1/t2a_v2', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = await res.json();
      if (json.base_resp?.status_code === 0 && json.data?.audio) return Buffer.from(json.data.audio, 'hex');
      if (!/rate limit|RPM/i.test(`${json.base_resp?.status_code}: ${json.base_resp?.status_msg}`)) throw new Error(json.base_resp?.status_msg ?? 'tts error');
    } else if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  throw new Error('TTS retries exhausted');
}

fs.mkdirSync(OUT, { recursive: true });
const manifestPath = path.join(OUT, 'manifest.json');
const known = fs.existsSync(manifestPath) && !FORCE ? new Map(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).map((m) => [m.id, m])) : new Map();
const todo = SENTENCES.map((text, i) => ({ id: `neg${String(i + 1).padStart(2, '0')}`, text }))
  .filter((x) => FORCE || !fs.existsSync(path.join(OUT, `${x.id}.wav`)));
console.log(`negative corpus dir: ${OUT}`);
console.log(`${todo.length} clip(s) to synthesize, ${SENTENCES.length - todo.length} already present`);

if (todo.length) {
  const key = loadKey();
  let i = 0;
  for (const item of todo) {
    const voice = VOICES[i % VOICES.length];
    i += 1;
    const t0 = Date.now();
    const buf = await synth(key, item.text, voice, 0.95 + (i % 3) * 0.05);
    const info = wavInfo(buf);
    fs.writeFileSync(path.join(OUT, `${item.id}.wav`), buf);
    known.set(item.id, { id: item.id, text: item.text, voice, durationMs: info.durationMs, file: `${item.id}.wav` });
    console.log(`  + ${item.id} ${String(info.durationMs).padStart(5)}ms "${item.text}" (${Date.now() - t0}ms)`);
    await new Promise((r) => setTimeout(r, 700));
  }
}
const ordered = SENTENCES.map((text, i) => known.get(`neg${String(i + 1).padStart(2, '0')}`)).filter(Boolean);
fs.writeFileSync(manifestPath, JSON.stringify(ordered, null, 2) + '\n');
console.log(`done: ${ordered.length} clips, ${(ordered.reduce((n, m) => n + m.durationMs, 0) / 1000).toFixed(1)}s`);
