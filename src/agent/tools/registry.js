// Tool registry helpers: index by name and render request schemas.
import { toChatTools } from './define.js';

/** @param {Array<object>} tools */
export function buildToolRegistry(tools) {
  const byName = new Map();
  for (const tool of tools) {
    if (typeof tool?.execute !== 'function') throw new Error(`tool ${tool?.name} has no execute()`);
    if (byName.has(tool.name)) throw new Error(`duplicate tool name ${tool.name}`);
    byName.set(tool.name, tool);
  }
  return {
    tools,
    byName,
    schemas: toChatTools(tools),
    get(name) {
      return byName.get(name);
    },
    names() {
      return [...byName.keys()];
    },
  };
}
