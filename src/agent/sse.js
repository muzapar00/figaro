// Minimal SSE (server-sent events) line splitter for the model stream.
//
// Turns a growing text buffer into complete `data:` payloads plus the unfinished
// remainder. Blank lines (event separators) and comment lines are dropped.
export function parseSseData(buffer) {
  const lines = [];
  let start = 0;
  let index;
  while ((index = buffer.indexOf('\n', start)) >= 0) {
    let line = buffer.slice(start, index);
    start = index + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith(':')) continue;
    if (trimmed.startsWith('data:')) {
      const payload = trimmed.slice(5).trim();
      if (payload.length > 0 && payload !== '[DONE]') lines.push(payload);
    }
    // Non-data SSE fields (event:, id:, retry:) carry nothing we need.
  }
  return { lines, remainder: buffer.slice(start) };
}
