import type { AgentLogEntry, AgentStatus } from '@shared/agent';
import { invoke, on } from '../bridge';
import { createStore, useStore } from '../state/store';
import { focusEntity, setUi } from '../state/ui';
import { currentWorld } from '../state/world';

/**
 * The renderer's side of the agent socket (docs/MCP.md): who is connected,
 * the settings, and the recent tool calls, kept in sync with main; and the
 * agent's `focus` and `view` tools, carried out here.
 */

const INITIAL: AgentStatus = {
  settings: { access: true, spend: false, budget: { sessionUsd: 1, monthUsd: 10 } },
  listening: false,
  connections: [],
  spend: { sessionUsd: 0, monthUsd: 0 },
};

export const agentStatusStore = createStore<AgentStatus>(INITIAL);
export const agentLogStore = createStore<AgentLogEntry[]>([]);

export const useAgentStatus = (): AgentStatus => useStore(agentStatusStore, (s) => s);
export const useAgentLog = (): AgentLogEntry[] => useStore(agentLogStore, (l) => l);

const VIEWS = new Set(['column', 'climate', 'codex', 'numbers', 'spread', 'taste', 'export']);

let started = false;

/** Follows the agent's status and log, and carries out reveals. Called once (the status line). */
export function startAgentSync(): void {
  if (started) return;
  started = true;
  on('agent:status', (s) => agentStatusStore.set(s));
  on('agent:logged', (e) => agentLogStore.set((l) => [...l.slice(-299), e]));
  on('agent:reveal', (r) => {
    if (r.view && VIEWS.has(r.view)) setUi({ view: r.view, overlay: null });
    if (r.entity && currentWorld()?.entities[r.entity]) focusEntity(r.entity);
  });
  void invoke('agent:status', null).then((s) => agentStatusStore.set(s));
  void invoke('agent:log', { limit: 300 }).then((l) => agentLogStore.set(l));
}

export const setAgentSettings = (patch: Partial<AgentStatus['settings']>): Promise<AgentStatus> =>
  invoke('agent:setSettings', patch).then((s) => {
    agentStatusStore.set(s);
    return s;
  });

/** "claude-code", or "2 agents". */
export function connectedLabel(s: AgentStatus): string | null {
  const n = s.connections.length;
  if (n === 0) return null;
  if (n > 1) return `${n} agents`;
  return s.connections[0]?.client ?? 'agent';
}
