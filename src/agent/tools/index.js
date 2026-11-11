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
import { createScreenshotTool, createViewImageTool } from './screen.js';
import { createHomeTool } from './home.js';
import { createRagTool } from './rag.js';
import { toChatTools, summarizeToolCall, redactArgs } from './define.js';

export const TOOL_NAMES = ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_search', 'web_fetch', 'screenshot', 'view_image', 'home'];

// Only offered when the host supplies a control hook: standing down is a daemon
// decision, not something a tool implementation can do on its own.
export const CONTROL_TOOL_NAMES = ['dismiss'];

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
  const control = options.control ?? null;
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
    createScreenshotTool(),
    createViewImageTool(),
  ];

  // Long-term memory tool: only when the agent wired a LightRAG client in.
  const ragTool = options.rag ? createRagTool({ rag: options.rag }) : null;
  if (ragTool) tools.push(ragTool);

  // Only offered when the user actually configured Home Assistant; otherwise the
  // model has no reason to see a tool that can only answer "not configured".
  const homeConfig = config.home ?? {};
  if (homeConfig.haUrl && homeConfig.haToken) {
    tools.push(createHomeTool({ config }));
  }

  if (control?.dismiss) {
    tools.push({
      name: 'dismiss',
      description:
        'Stand down: the user told you to leave, rest, stop listening or that you are no longer needed. '
        + 'After calling it, reply with at most one short sentence (for example 好，我先退下). Do not explain and do not do other work.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        control.dismiss();
        return { content: 'dismissed' };
      },
    });
  }

  return tools.filter((tool) => {
    if (!enableWeb && (tool.name === 'web_search' || tool.name === 'web_fetch')) return false;
    if (requested) return requested.has(tool.name);
    return true;
  });
}

export { summarizeToolCall, redactArgs, toChatTools };
export { buildToolRegistry } from './registry.js';
