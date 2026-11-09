// Tool registry for the Figaro agent.
//
// Kept tools: bash, read, write, edit, glob, grep, web_search, web_fetch.
// Deliberately dropped from the dsh catalog: present, ask_user_question,
// subagent/subagent_fork, workflow, schedule, todo, goal, jobs, skills, plan
// mode, computer-use — none of them make sense for a voice assistant that has
// to answer out loud.
import os from 'node:os';
import path from 'node:path';
import { createBashTool } from './bash.js';
import { createReadTool, createWriteTool, createEditTool } from './fs.js';
import { createGlobTool, createGrepTool } from './search.js';
import { createWebSearchTool, createWebFetchTool } from './web.js';
import { toChatTools, summarizeToolCall, redactArgs } from './define.js';

export const TOOL_NAMES = ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_search', 'web_fetch'];

/** Default working directory for tools: FIGARO_WORKDIR, else the process cwd. */
export function defaultToolWorkdir(config) {
  return config?.agent?.workdir || process.env.FIGARO_WORKDIR || process.cwd();
}

/**
 * @param {{ config?: object, workdir?: string, enableWeb?: boolean }} [options]
 * @returns {Array<object>} declared tools
 */
export function createTools(options = {}) {
  const config = options.config ?? {};
  const workdir = options.workdir ?? defaultToolWorkdir(config);
  const enableWeb = options.enableWeb ?? config.agent?.web !== false;
  const requested = Array.isArray(config.agent?.tools) && config.agent.tools.length > 0
    ? new Set(config.agent.tools)
    : null;

  const tools = [
    createBashTool({
      workdir,
      defaultTimeoutMs: config.agent?.bashTimeoutMs,
      maxTimeoutMs: config.agent?.bashMaxTimeoutMs,
      spillDir: path.join(os.tmpdir(), 'figaro-tool-output'),
    }),
    createReadTool({ workdir }),
    createWriteTool({ workdir }),
    createEditTool({ workdir }),
    createGlobTool({ workdir }),
    createGrepTool({ workdir }),
    createWebSearchTool(),
    createWebFetchTool(),
  ];

  return tools.filter((tool) => {
    if (!enableWeb && (tool.name === 'web_search' || tool.name === 'web_fetch')) return false;
    if (requested) return requested.has(tool.name);
    return true;
  });
}

export { summarizeToolCall, redactArgs, toChatTools };
export { buildToolRegistry } from './registry.js';
