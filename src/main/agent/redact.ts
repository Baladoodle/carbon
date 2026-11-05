/**
 * The last line of defence for "no tool returns an API key" (docs/MCP.md §5).
 * No tool reads a key (they live in the keyring or the environment, which no
 * tool touches), but the world's own text could hold one pasted by accident.
 * Anything shaped like an Anthropic or OpenAI key, and the keys this process
 * holds in its environment, are replaced before a result leaves carbon.
 */
const SHAPES = [
  /sk-ant-[A-Za-z0-9]+-[A-Za-z0-9_-]{16,}/g,
  /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g,
];

export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const k of [env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY])
    if (typeof k === 'string' && k.length >= 16) out = out.split(k).join('[redacted]');
  for (const re of SHAPES) out = out.replace(re, '[redacted]');
  return out;
}
