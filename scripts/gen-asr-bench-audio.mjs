#!/usr/bin/env node
// Generate the ASR accuracy benchmark corpus with MiniMax TTS.
//
//   node scripts/gen-asr-bench-audio.mjs            # generate missing clips
//   node scripts/gen-asr-bench-audio.mjs --force
//   node scripts/gen-asr-bench-audio.mjs --seconds  # only report
//
// Output: models/bench-audio/<id>.wav (16 kHz mono s16) + manifest.json
// `models/` is git-ignored, so this corpus stays out of the repository (it is
// reproducible with the user's own TTS key, which is never printed or stored).
//
// The corpus is used by scripts/asr-cer-bench.mjs to compare offline models on
// clean and noisy channels.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'models', 'bench-audio');
const CONFIG_PATH = path.join(process.env.HOME, '.config', 'figaro', 'config.json');
const VOICES = ['male-qn-jingying', 'female-shaonv', 'male-qn-qingse', 'female-tianmei'];

// id, text, voice index, speed
const SENTENCES = [
  ['time', '现在几点了', 0, 1.0],
  ['weather', '明天北京天气怎么样', 1, 1.0],
  ['light', '帮我打开客厅的灯', 2, 1.0],
  ['music', '播放周杰伦的七里香', 3, 1.0],
  ['volume-down', '把音量调小一点', 0, 1.0],
  ['remind-meeting', '提醒我半小时后开会', 1, 1.05],
  ['news', '今天有什么新闻', 2, 1.0],
  ['express', '帮我查一下快递到哪了', 3, 1.0],
  ['bilibili', '打开哔哩哔哩', 0, 1.0],
  ['coffee', '搜索附近的咖啡店', 1, 1.0],
  ['wechat-mom', '给妈妈发一条微信说我晚点回家', 2, 1.0],
  ['alarm', '明天早上七点叫醒我', 3, 1.0],
  ['song-name', '这首歌叫什么名字', 0, 1.0],
  ['pause', '暂停播放', 1, 0.95],
  ['next-song', '下一首', 2, 1.0],
  ['todo', '帮我记一下明天的待办事项', 3, 1.05],
  ['calc', '计算一下三百四十五乘以十二等于多少', 0, 1.0],
  ['translate', '翻译一下这句话', 1, 1.0],
  ['settings', '打开系统设置', 2, 1.0],
  ['bluetooth-off', '关闭蓝牙', 3, 1.0],
  ['stocks', '查一下今天的股票行情', 0, 1.05],
  ['hungry', '我有点饿了附近有什么好吃的', 1, 1.0],
  ['train-ticket', '帮我订一张明天去上海的高铁票', 2, 1.0],
  ['brightness', '把屏幕亮度调到百分之五十', 3, 1.0],
  ['battery', '现在电脑还剩多少电量', 0, 1.0],
  ['pdf', '帮我把这份文档转换成PDF', 1, 1.0],
  ['temperature', '今天气温多少度', 2, 1.0],
  ['call-teacher', '提醒我明天下午三点打电话给张老师', 3, 1.0],
  ['light-music', '播放一首轻音乐', 0, 1.0],
  ['calculator', '打开计算器', 1, 1.0],
  ['summarize', '帮我总结一下这篇文章', 2, 1.05],
  ['date', '现在几号了', 3, 1.0],
  ['weekday', '一周后是什么日子', 0, 1.0],
  ['email', '帮我看看有没有新的邮件', 1, 1.0],
  ['memo', '把刚才那段话记到备忘录里', 2, 1.0],
  ['yesterday-task', '我昨天让你查的事情怎么样了', 3, 1.05],
  ['schedule', '打开我的日程安排', 0, 1.0],
  ['mute', '帮我把音量静音', 1, 1.0],
  ['rain', '现在外面下雨了吗', 2, 1.0],
  ['movie', '推荐一部好看的电影', 3, 1.0],
  ['qqmusic', '打开QQ音乐', 0, 1.0],
  ['open-wechat', '把微信打开', 1, 1.0],
  ['figaro-aria', '播放费加罗的咏叹调', 2, 1.0],
  ['flight', '查询航班号CA1234', 3, 1.0],
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
  let off = 12;
  let fmt = null;
  let dataBytes = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    else if (id === 'data') dataBytes = size;
    off = body + size + (size % 2);
  }
  const frameBytes = (fmt.channels * fmt.bits) / 8;
  return { ...fmt, dataBytes, durationMs: Math.round((dataBytes / frameBytes / fmt.sampleRate) * 1000) };
}

async function synth(key, text, voice, speed) {
  const body = {
    model: 'speech-02-turbo',
    text,
    stream: false,
    voice_setting: { voice_id: voice, speed, vol: 1.0, pitch: 0 },
    audio_setting: { sample_rate: 16000, bitrate: 128000, format: 'wav', channel: 1 },
  };
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch('https://api.minimax.cn/v1/t2a_v2', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = await res.json();
      if (json.base_resp?.status_code === 0 && json.data?.audio) return Buffer.from(json.data.audio, 'hex');
      const msg = `${json.base_resp?.status_code}: ${json.base_resp?.status_msg}`;
      if (!/rate limit|RPM/i.test(msg)) throw new Error(msg);
    } else if (res.status !== 429 && res.status < 500) {
      throw new Error(`HTTP ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  throw new Error('TTS retries exhausted');
}

fs.mkdirSync(OUT, { recursive: true });
const manifestPath = path.join(OUT, 'manifest.json');
const existing = fs.existsSync(manifestPath) && !FORCE
  ? new Map(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).map((m) => [m.id, m]))
  : new Map();
const todo = SENTENCES.filter(([id]) => FORCE || !fs.existsSync(path.join(OUT, `${id}.wav`)));
console.log(`corpus dir: ${OUT}`);
console.log(`${todo.length} clip(s) to synthesize, ${SENTENCES.length - todo.length} already present`);

if (todo.length) {
  const key = loadKey();
  for (const [id, text, voiceIdx, speed] of todo) {
    const voice = VOICES[voiceIdx % VOICES.length];
    const t0 = Date.now();
    const buf = await synth(key, text, voice, speed);
    const info = wavInfo(buf);
    if (info.sampleRate !== 16000 || info.channels !== 1) throw new Error(`${id}: bad wav ${JSON.stringify(info)}`);
    fs.writeFileSync(path.join(OUT, `${id}.wav`), buf);
    existing.set(id, { id, text, voice, speed, durationMs: info.durationMs, bytes: buf.length, file: `${id}.wav` });
    console.log(`  + ${id.padEnd(18)} ${String(info.durationMs).padStart(5)}ms  "${text}"  (${Date.now() - t0}ms)`);
    await new Promise((r) => setTimeout(r, 700));
  }
}
const ordered = SENTENCES.map(([id]) => existing.get(id)).filter(Boolean);
fs.writeFileSync(manifestPath, JSON.stringify(ordered, null, 2) + '\n');
const totalMs = ordered.reduce((n, m) => n + m.durationMs, 0);
console.log(`done: ${ordered.length} clips, ${(totalMs / 1000).toFixed(1)}s audio, manifest=${path.relative(ROOT, manifestPath)}`);
