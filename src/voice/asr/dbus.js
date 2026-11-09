// Minimal D-Bus client (zero dependencies).
//
// Why hand-written: the repo may only depend on `ws` + `sherpa-onnx-node`; Node
// has no built-in D-Bus. We need just enough of the protocol for the XDG
// GlobalShortcuts portal:
//   - SASL EXTERNAL auth over the session bus unix socket
//   - Hello()
//   - method calls with a{sv} / a(sa{sv}) arguments
//   - method returns + errors
//   - signal subscription (Activated / Deactivated / Response)
//
// Supported wire types: y b n q i u x t d s o g a T ( ) { } v. That covers every
// signature used by the portal and by the unit tests.
//
// Wire format reference: https://dbus.freedesktop.org/doc/dbus-specification.html

import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const os = require('node:os');

const ENDIAN = 0x6c; // 'l' little endian
const TYPE_METHOD_CALL = 1;
const TYPE_METHOD_RETURN = 2;
const TYPE_ERROR = 3;
const TYPE_SIGNAL = 4;

// ---------------------------------------------------------------------------
// signature helpers
// ---------------------------------------------------------------------------

/**
 * Split a signature into its complete top-level type tokens.
 * @param {string} sig
 * @returns {string[]}
 */
export function splitSignature(sig) {
  const out = [];
  let i = 0;
  const readOne = () => {
    const start = i;
    const ch = sig[i++];
    if (!ch) throw new Error(`bad signature '${sig}'`);
    if (ch === 'a') {
      readOne();
      return sig.slice(start, i);
    }
    if (ch === '(' || ch === '{') {
      const close = ch === '(' ? ')' : '}';
      while (i < sig.length && sig[i] !== close) readOne();
      if (sig[i] !== close) throw new Error(`unbalanced signature '${sig}'`);
      i++;
      return sig.slice(start, i);
    }
    if ('ybnqiuxtdsogv'.includes(ch)) return ch;
    throw new Error(`unsupported signature char '${ch}' in '${sig}'`);
  };
  while (i < sig.length) out.push(readOne());
  return out;
}

function alignmentOf(sig) {
  const t = sig[0];
  switch (t) {
    case 'y': case 'g': case 'v': return 1;
    case 'n': case 'q': return 2;
    case 'b': case 'i': case 'u': case 's': case 'o': case 'a': return 4;
    case 'x': case 't': case 'd': case '(': case '{': return 8;
    default: throw new Error(`unsupported type '${sig}'`);
  }
}

function padTo(n, align) {
  return (align - (n % align)) % align;
}

// ---------------------------------------------------------------------------
// writer
// ---------------------------------------------------------------------------

class Writer {
  constructor(capacity = 512) {
    this.buf = Buffer.alloc(capacity);
    this.pos = 0;
  }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = Buffer.alloc(size);
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
  }
  align(align) {
    const n = padTo(this.pos, align);
    if (!n) return;
    this.ensure(n);
    this.buf.fill(0, this.pos, this.pos + n);
    this.pos += n;
  }
  byte(v) { this.ensure(1); this.buf[this.pos++] = v & 0xff; }
  u32(v) { this.align(4); this.ensure(4); this.buf.writeUInt32LE(v >>> 0, this.pos); this.pos += 4; }
  u64(v) { this.align(8); this.ensure(8); this.buf.writeBigUInt64LE(BigInt(v), this.pos); this.pos += 8; }
  i32(v) { this.align(4); this.ensure(4); this.buf.writeInt32LE(v | 0, this.pos); this.pos += 4; }
  i64(v) { this.align(8); this.ensure(8); this.buf.writeBigInt64LE(BigInt(v), this.pos); this.pos += 8; }
  double(v) { this.align(8); this.ensure(8); this.buf.writeDoubleLE(v, this.pos); this.pos += 8; }
  stringBody(v) {
    const b = Buffer.from(String(v), 'utf8');
    this.u32(b.length);
    this.ensure(b.length + 1);
    b.copy(this.buf, this.pos);
    this.pos += b.length;
    this.byte(0);
  }
  signatureBody(v) {
    const s = String(v);
    const b = Buffer.from(s, 'utf8');
    this.align(1);
    this.byte(b.length);
    this.ensure(b.length + 1);
    b.copy(this.buf, this.pos);
    this.pos += b.length;
    this.byte(0);
  }
  /**
   * Marshal one value for a single complete type token.
   * @param {string} sig
   * @param {any} value
   */
  value(sig, value) {
    const t = sig[0];
    switch (t) {
      case 'y': this.align(1); this.byte(Number(value)); return;
      case 'b': this.align(4); this.u32(value ? 1 : 0); return;
      case 'n': this.align(2); this.ensure(2); this.buf.writeInt16LE(Number(value) | 0, this.pos); this.pos += 2; return;
      case 'q': this.align(2); this.ensure(2); this.buf.writeUInt16LE(Number(value) >>> 0, this.pos); this.pos += 2; return;
      case 'i': case 'h': this.i32(Number(value)); return;
      case 'u': this.u32(Number(value)); return;
      case 'x': this.i64(value); return;
      case 't': this.u64(value); return;
      case 'd': this.double(Number(value)); return;
      case 's': case 'o': this.align(4); this.stringBody(value); return;
      case 'g': this.signatureBody(value); return;
      case 'a': {
        const elemSig = sig.slice(1);
        this.align(4);
        const lenPos = this.pos;
        this.u32(0); // placeholder
        this.align(alignmentOf(elemSig));
        const start = this.pos;
        let items;
        if (Array.isArray(value)) items = value;
        else if (value && typeof value === 'object') items = Object.entries(value);
        else items = [...(value ?? [])];
        for (const item of items) this.value(elemSig, item);
        const len = this.pos - start;
        this.buf.writeUInt32LE(len, lenPos);
        return;
      }
      case '(': {
        this.align(8);
        const inner = sig.slice(1, -1);
        const fields = splitSignature(inner);
        const arr = Array.isArray(value) ? value : [];
        fields.forEach((f, idx) => this.value(f, arr[idx]));
        return;
      }
      case '{': {
        this.align(8);
        const inner = sig.slice(1, -1);
        const [ks, vs] = splitSignature(inner);
        this.value(ks, value[0]);
        this.value(vs, value[1]);
        return;
      }
      case 'v': {
        const v = value ?? { signature: 's', value: '' };
        this.signatureBody(v.signature);
        this.align(alignmentOf(v.signature));
        this.value(v.signature, v.value);
        return;
      }
      default:
        throw new Error(`cannot marshal signature '${sig}'`);
    }
  }
  result() {
    return this.buf.subarray(0, this.pos);
  }
}

// ---------------------------------------------------------------------------
// reader
// ---------------------------------------------------------------------------

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  align(align) {
    this.pos += padTo(this.pos, align);
    if (this.pos > this.buf.length) throw new Error('dbus: read past end');
  }
  byte() { this.align(1); return this.buf[this.pos++]; }
  u32() { this.align(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  u64() { this.align(8); const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return v; }
  i32() { this.align(4); const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  i64() { this.align(8); const v = this.buf.readBigInt64LE(this.pos); this.pos += 8; return v; }
  double() { this.align(8); const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }
  readNulString(len) {
    const s = this.buf.subarray(this.pos, this.pos + len).toString('utf8');
    this.pos += len;
    if (this.buf[this.pos] !== 0) throw new Error('dbus: expected NUL after string');
    this.pos += 1;
    return s;
  }
  stringBody() { this.align(4); return this.readNulString(this.u32()); }
  signatureBody() { this.align(1); return this.readNulString(this.byte()); }
  value(sig) {
    const t = sig[0];
    switch (t) {
      case 'y': return this.byte();
      case 'b': return this.u32() !== 0;
      case 'n': this.align(2); { const v = this.buf.readInt16LE(this.pos); this.pos += 2; return v; }
      case 'q': this.align(2); { const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
      case 'i': return this.i32();
      case 'u': return this.u32();
      case 'x': return Number(this.i64());
      case 't': return Number(this.u64());
      case 'd': return this.double();
      case 's': return this.stringBody();
      case 'o': return this.stringBody();
      case 'g': return this.signatureBody();
      case 'a': {
        this.align(4);
        const len = this.u32();
        const elemSig = sig.slice(1);
        this.align(alignmentOf(elemSig));
        const end = this.pos + len;
        const out = [];
        while (this.pos < end) out.push(this.value(elemSig));
        if (this.pos !== end) throw new Error('dbus: array length mismatch');
        return out;
      }
      case '(': {
        this.align(8);
        const inner = splitSignature(sig.slice(1, -1));
        return inner.map((f) => this.value(f));
      }
      case '{': {
        this.align(8);
        const inner = splitSignature(sig.slice(1, -1));
        return [this.value(inner[0]), this.value(inner[1])];
      }
      case 'v': {
        const signature = this.signatureBody();
        this.align(alignmentOf(signature));
        return { signature, value: this.value(signature) };
      }
      default:
        throw new Error(`cannot unmarshal signature '${sig}'`);
    }
  }
}

function variant(signature, value) {
  return { signature, value };
}
export { variant };

// ---------------------------------------------------------------------------
// message encode / decode
// ---------------------------------------------------------------------------

let SERIAL_START = 1;

function encodeMessage({ type, flags = 0, serial, fields = {}, signature = '', bodyBuffer = null }) {
  const headerWriter = new Writer(256);
  const writeField = (code, sig, value) => {
    headerWriter.align(8);
    headerWriter.byte(code);
    headerWriter.value('v', { signature: sig, value });
  };
  if (fields.path) writeField(1, 'o', fields.path);
  if (fields.interface) writeField(2, 's', fields.interface);
  if (fields.member) writeField(3, 's', fields.member);
  if (fields.errorName) writeField(4, 's', fields.errorName);
  if (fields.replySerial !== undefined) writeField(5, 'u', fields.replySerial);
  if (fields.destination) writeField(6, 's', fields.destination);
  if (fields.sender) writeField(7, 's', fields.sender);
  if (signature) writeField(8, 'g', signature);
  const hdr = headerWriter.result();

  const bodyLen = bodyBuffer ? bodyBuffer.length : 0;
  const headerPad = padTo(hdr.length, 8);
  const total = 16 + hdr.length + headerPad + bodyLen;
  const msg = Buffer.alloc(total);
  msg[0] = ENDIAN;
  msg[1] = type;
  msg[2] = flags;
  msg[3] = 1;
  msg.writeUInt32LE(bodyLen, 4);
  msg.writeUInt32LE(serial >>> 0, 8);
  msg.writeUInt32LE(hdr.length, 12);
  hdr.copy(msg, 16);
  // header padding stays zero
  if (bodyBuffer) bodyBuffer.copy(msg, 16 + hdr.length + headerPad);
  return msg;
}

function decodeMessages(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 16) {
    if (buffer[offset] !== ENDIAN) throw new Error(`dbus: unsupported endianness 0x${buffer[offset].toString(16)}`);
    const type = buffer[offset + 1];
    const flags = buffer[offset + 2];
    const bodyLen = buffer.readUInt32LE(offset + 4);
    const serial = buffer.readUInt32LE(offset + 8);
    const hdrLen = buffer.readUInt32LE(offset + 12);
    const headerEnd = offset + 16 + hdrLen;
    const bodyStart = offset + 16 + hdrLen + padTo(hdrLen, 8);
    const msgEnd = bodyStart + bodyLen;
    if (buffer.length < msgEnd) break;
    const reader = new Reader(buffer.subarray(offset + 16, headerEnd));
    const fields = {};
    const bodyReader = new Reader(buffer.subarray(bodyStart, msgEnd));
    while (reader.pos < reader.buf.length) {
      reader.align(8);
      if (reader.pos >= reader.buf.length) break;
      const code = reader.byte();
      const v = reader.value('v');
      bodyReader;
      switch (code) {
        case 1: fields.path = v.value; break;
        case 2: fields.interface = v.value; break;
        case 3: fields.member = v.value; break;
        case 4: fields.errorName = v.value; break;
        case 5: fields.replySerial = v.value; break;
        case 6: fields.destination = v.value; break;
        case 7: fields.sender = v.value; break;
        case 8: fields.signature = v.value; break;
        default: break;
      }
    }
    messages.push({ type, flags, serial, fields, body: bodyReader });
    offset = msgEnd;
  }
  return { messages, rest: buffer.subarray(offset) };
}

/** Marshal a body from a signature string and JS values. */
export function marshalBody(signature, values) {
  const w = new Writer(256);
  const sigs = splitSignature(signature);
  sigs.forEach((sig, i) => w.value(sig, values[i]));
  return w.result();
}

/** Unmarshal a body. Returns an array of top-level values. */
export function unmarshalBody(readerOrBuf, signature) {
  const reader = readerOrBuf instanceof Reader ? readerOrBuf : new Reader(readerOrBuf);
  return splitSignature(signature).map((sig) => reader.value(sig));
}

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------

function parseBusAddress(address) {
  const addr = address || process.env.DBUS_SESSION_BUS_ADDRESS ||
    `unix:path=/run/user/${typeof process.getuid === 'function' ? process.getuid() : 1000}/bus`;
  for (const part of addr.split(';')) {
    const m = /^(unix|tcp):(.*)$/.exec(part.trim());
    if (!m) continue;
    if (m[1] !== 'unix') continue;
    const params = new Map();
    for (const kv of m[2].split(',')) {
      const eq = kv.indexOf('=');
      if (eq > 0) params.set(kv.slice(0, eq), decodeURIComponent(kv.slice(eq + 1)));
    }
    if (params.has('path')) return { path: params.get('path') };
    if (params.has('abstract')) return { abstract: params.get('abstract') };
    if (params.has('runtime') && params.get('runtime') === 'yes') {
      return { path: `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 1000}/bus` };
    }
  }
  throw new Error(`unsupported D-Bus address: ${addr}`);
}

function uidHex() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  return Buffer.from(String(uid), 'utf8').toString('hex');
}

/**
 * Connect to the session bus and authenticate.
 *
 * @param {object} [opts]
 * @param {string} [opts.address] D-Bus address (default: $DBUS_SESSION_BUS_ADDRESS)
 * @param {number} [opts.callTimeoutMs] per-method-call timeout (default 8000)
 */
export async function connect(opts = {}) {
  const { address, callTimeoutMs = 8000 } = opts;
  const target = parseBusAddress(address);

  const socket = await new Promise((resolve, reject) => {
    const opts2 = target.abstract
      ? { path: `\0${target.abstract}` }
      : { path: target.path };
    const sock = net.createConnection(opts2);
    const onError = (err) => reject(new Error(`无法连接 D-Bus 会话总线：${err.message}`, { cause: err }));
    sock.once('error', onError);
    sock.once('connect', () => {
      sock.off('error', onError);
      resolve(sock);
    });
  });

  const conn = new DBusConnection(socket, { callTimeoutMs });
  await conn._handshake();
  await conn._hello();
  return conn;
}

export class DBusConnection {
  constructor(socket, { callTimeoutMs = 8000 } = {}) {
    this.socket = socket;
    this.callTimeoutMs = callTimeoutMs;
    this.serial = SERIAL_START;
    this.pending = new Map();
    this.signalHandlers = [];
    this.buffer = Buffer.alloc(0);
    this.uniqueName = null;
    this.closed = false;
    this._onData = (buf) => this._handleData(buf);
    this._onClose = () => this._handleClose();
    this._listening = false;
    socket.on('close', this._onClose);
    socket.on('error', this._onClose);
  }

  /** Switch from the SASL text phase to the binary message phase. */
  _startMessages() {
    if (this._listening) return;
    this._listening = true;
    this.socket.on('data', this._onData);
    if (this.buffer.length) this._handleData(Buffer.alloc(0));
  }

  async _handshake() {
    const socket = this.socket;
    await new Promise((resolve, reject) => {
      let state = 'auth';
      let buf = '';
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('D-Bus 认证超时（会话总线无响应）'));
      }, this.callTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
      };
      const onError = (err) => { cleanup(); reject(new Error(`D-Bus 认证失败：${err.message}`, { cause: err })); };
      const onData = (chunk) => {
        buf += chunk.toString('ascii');
        // First reply line.
        if (state === 'auth') {
          const nl = buf.indexOf('\r\n');
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          if (!line.startsWith('OK ')) {
            cleanup();
            reject(new Error(`D-Bus EXTERNAL 认证被拒绝：${line}`));
            return;
          }
          this.guid = line.slice(3).trim();
          state = 'begin';
          socket.write('BEGIN\r\n');
          cleanup();
          resolve();
        }
      };
      socket.on('data', onData);
      socket.on('error', onError);
      socket.write(Buffer.concat([Buffer.from([0]), Buffer.from(`AUTH EXTERNAL ${uidHex()}\r\n`, 'ascii')]));
    });
    // After BEGIN, any leftover bytes are message bytes (normally none).
    this._startMessages();
  }

  async _hello() {
    const [unique] = await this.call({
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus',
      member: 'Hello',
    });
    this.uniqueName = unique;
    return unique;
  }

  _handleClose() {
    if (this.closed) return;
    this.closed = true;
    for (const [serial, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(new Error('D-Bus 连接已关闭'));
      this.pending.delete(serial);
    }
  }

  _handleData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let decoded;
    try {
      decoded = decodeMessages(this.buffer);
    } catch (err) {
      // Protocol corruption: fail all pending calls rather than spin forever.
      this.buffer = Buffer.alloc(0);
      for (const [, { reject, timer }] of this.pending) { clearTimeout(timer); reject(err); }
      this.pending.clear();
      return;
    }
    this.buffer = decoded.rest;
    for (const msg of decoded.messages) this._dispatch(msg);
  }

  _dispatch(msg) {
    if (msg.type === TYPE_METHOD_RETURN || msg.type === TYPE_ERROR) {
      const pending = this.pending.get(msg.fields.replySerial);
      if (!pending) return;
      this.pending.delete(msg.fields.replySerial);
      clearTimeout(pending.timer);
      try {
        if (msg.type === TYPE_ERROR) {
          const sig = msg.fields.signature ?? '';
          let detail = '';
          try { detail = unmarshalBody(msg.body, sig)[0] ?? ''; } catch { /* ignore */ }
          const err = new Error(`D-Bus 调用失败：${msg.fields.errorName ?? 'unknown'}${detail ? ` (${detail})` : ''}`);
          err.dbusErrorName = msg.fields.errorName;
          pending.reject(err);
        } else {
          const sig = msg.fields.signature ?? '';
          pending.resolve(unmarshalBody(msg.body, sig));
        }
      } catch (err) {
        pending.reject(err);
      }
      return;
    }
    if (msg.type === TYPE_SIGNAL) {
      const iface = msg.fields.interface;
      const member = msg.fields.member;
      const sig = msg.fields.signature ?? '';
      let args;
      try {
        args = unmarshalBody(msg.body, sig);
      } catch {
        args = [];
      }
      for (const handler of this.signalHandlers) {
        if (handler.interface !== iface || handler.member !== member) continue;
        if (handler.path && handler.path !== msg.fields.path) continue;
        if (handler.sender && handler.sender !== msg.fields.sender) continue;
        try { handler.fn({ path: msg.fields.path, sender: msg.fields.sender, args }); } catch { /* ignore handler errors */ }
      }
    }
  }

  /**
   * Subscribe to a signal. Returns an unsubscribe function.
   * Call addMatch() first so the bus actually delivers the signal to us.
   */
  onSignal({ interface: iface, member, path: msgPath, sender }, fn) {
    const handler = { interface: iface, member, path: msgPath, sender, fn };
    this.signalHandlers.push(handler);
    return () => {
      this.signalHandlers = this.signalHandlers.filter((h) => h !== handler);
    };
  }

  async addMatch(rule) {
    await this.call({
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus',
      member: 'AddMatch',
      signature: 's',
      body: [rule],
    });
  }

  /**
   * Call a method. Returns an array with the reply body's top-level values.
   * @param {{destination: string, path: string, interface: string, member: string, signature?: string, body?: any[], timeoutMs?: number}} opts
   */
  call(opts) {
    const { destination, path, interface: iface, member, signature = '', body = [], timeoutMs } = opts;
    if (this.closed) return Promise.reject(new Error('D-Bus 连接已关闭'));
    const serial = this.serial++;
    const bodyBuffer = signature ? marshalBody(signature, body) : null;
    const msg = encodeMessage({
      type: TYPE_METHOD_CALL,
      serial,
      fields: { path, interface: iface, member, destination },
      signature,
      bodyBuffer,
    });
    const timeout = timeoutMs ?? this.callTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(serial);
        reject(new Error(`D-Bus 调用超时：${iface}.${member} (${timeout}ms)`));
      }, timeout) : null;
      this.pending.set(serial, { resolve, reject, timer });
      try {
        this.socket.write(msg);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(serial);
        reject(err);
      }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.end(); } catch { /* ignore */ }
    try { this.socket.destroy(); } catch { /* ignore */ }
    for (const [, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(new Error('D-Bus 连接已关闭'));
    }
    this.pending.clear();
  }
}

export default { connect, DBusConnection, marshalBody, unmarshalBody, splitSignature, variant };
