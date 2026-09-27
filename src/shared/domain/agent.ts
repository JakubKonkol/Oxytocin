import { z } from 'zod';

export const AgentStateSchema = z.enum(['starting', 'working', 'idle', 'waiting', 'unknown']);
export type AgentState = z.infer<typeof AgentStateSchema>;

export const AgentStateSourceSchema = z.enum([
  'hook',
  'claude-registry',
  'osc-progress',
  'bell',
  'output-heuristic',
  'none',
]);
export type AgentStateSource = z.infer<typeof AgentStateSourceSchema>;

export const AgentInfoSchema = z.object({
  agentId: z.string(),
  displayName: z.string(),
  provider: z.string(),
  pid: z.number(),
  sessionId: z.string().optional(),
  /** Session title reported by the agent (tooltip). */
  sessionName: z.string().optional(),
  state: AgentStateSchema,
  waitingFor: z.string().optional(),
  stateSource: AgentStateSourceSchema,
  since: z.number(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

/** A state reported by the agent itself through a plugin (`oxy.agents.reportState`, source `hook`). */
export const AgentStateReportSchema = z.object({
  state: z.enum(['working', 'idle', 'waiting']),
  waitingFor: z.string().max(200).optional(),
  sessionId: z.string().max(200).optional(),
});
export type AgentStateReport = z.infer<typeof AgentStateReportSchema>;

export const AgentInfoWithTerminalSchema = AgentInfoSchema.extend({ terminalId: z.string(), projectId: z.string() });
export type AgentInfoWithTerminal = z.infer<typeof AgentInfoWithTerminalSchema>;

export const AGENT_STATE_LABELS: Record<AgentState, string> = {
  starting: 'starting',
  working: 'working',
  idle: 'idle',
  waiting: 'waiting for you',
  unknown: 'running',
};
