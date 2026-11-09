// Tool declaration helpers for the Figaro agent.
//
// The declaration shape is deliberately the same one DeepSeek Harness uses
// internally (`dsh-tool-*` packages): a name, a description, a `parameters`
// object written as a plain map of dsh-style parameter nodes, and an async
// `execute`. `toChatTools()` converts that into the JSON-Schema `tools` array
// the DeepSeek /chat/completions endpoint expects, so the descriptions and the
// parameter texts can be carried over from the dsh packages verbatim while the
// implementation stays Figaro's own.
//
// dsh-style parameter node:
//   { type: 'string', required?: true, description?: string,
//     enum?: string[], items?: node, properties?: { [k]: node },
//     oneOf?: node[] }

/** @param {object} spec */
export function defineTool({ name, description, parameters = {}, execute, timeoutMs }) {
  return Object.freeze({ name, description, parameters, execute, timeoutMs });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nodeToSchema(node) {
  const out = {};
  if (node.description !== undefined) out.description = node.description;
  if (node.enum !== undefined) out.enum = [...node.enum];
  if (node.type !== undefined) out.type = node.type;
  if (node.items !== undefined) out.items = nodeToSchema(node.items);
  if (node.oneOf !== undefined) out.oneOf = node.oneOf.map(nodeToSchema);
  if (node.properties !== undefined) {
    const properties = {};
    const required = [];
    for (const [key, child] of Object.entries(node.properties)) {
      properties[key] = nodeToSchema(child);
      if (child.required === true) required.push(key);
    }
    out.type = out.type ?? 'object';
    out.properties = properties;
    if (required.length > 0) out.required = required;
  }
  return out;
}

/** Convert a dsh-style parameter map to a JSON Schema object. */
export function parametersToJsonSchema(parameters = {}) {
  const properties = {};
  const required = [];
  for (const [key, node] of Object.entries(parameters)) {
    properties[key] = nodeToSchema(node);
    if (node.required === true) required.push(key);
  }
  const schema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** Convert declared tools to the OpenAI/DeepSeek `tools` request field. */
export function toChatTools(tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: parametersToJsonSchema(tool.parameters),
    },
  }));
}

/**
 * Build a short, human-readable summary of a tool call for onToolEvent.
 * Kept short on purpose: the daemon forwards it to the overlay, not the model.
 */
export function summarizeToolCall(name, args = {}) {
  const cut = (value, n = 80) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > n ? `${text.slice(0, n - 1)}…` : text;
  };
  switch (name) {
    case 'bash':
      return cut(args.description || args.command);
    case 'read':
    case 'write':
    case 'edit':
      return cut(args.file_path);
    case 'glob':
      return cut(args.pattern);
    case 'grep':
      return cut(args.pattern);
    case 'web_search':
      return cut(Array.isArray(args.queries) ? args.queries.join(' / ') : args.queries);
    case 'web_fetch':
      return cut(args.url);
    default:
      return cut(JSON.stringify(args));
  }
}

/** Safe-ish argument object for logs (JSON args are model output, never trusted). */
export function redactArgs(args) {
  if (args === null || typeof args !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (/key|token|secret|password/i.test(key)) {
      out[key] = '[redacted]';
    } else if (typeof value === 'string') {
      out[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export { escapeRegExp };
