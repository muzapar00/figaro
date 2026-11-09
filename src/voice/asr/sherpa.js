// Lazy loader for sherpa-onnx-node (a CommonJS native-addon package).
//
// Loading it lazily keeps `import('./src/voice/asr/index.js')` cheap and lets a
// broken/missing native addon surface as a clean onError from start() instead of
// an import-time crash of the whole daemon.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let cached = null;
let loadError = null;

/** @returns {any} the sherpa-onnx-node module (throws if unavailable) */
export function loadSherpa() {
  if (cached) return cached;
  if (loadError) throw loadError;
  try {
    cached = require('sherpa-onnx-node');
    return cached;
  } catch (err) {
    loadError = new Error(
      `sherpa-onnx-node 不可用（npm 依赖缺失或 native addon 与当前 Node/平台不匹配）：${err.message}`,
      { cause: err },
    );
    throw loadError;
  }
}

export function sherpaAvailable() {
  try { loadSherpa(); return true; } catch { return false; }
}

export default { loadSherpa, sherpaAvailable };
