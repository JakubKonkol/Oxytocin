/** Resume commands per agent (roadmap M7-T6); `${sessionId}` is replaced. Never run automatically. */
const RESUME: Readonly<Record<string, { name: string; template: string }>> = {
  'claude-code': { name: 'Claude Code', template: 'claude --resume ${sessionId}' },
  codex: { name: 'Codex', template: 'codex resume ${sessionId}' },
  'gemini-cli': { name: 'Gemini CLI', template: 'gemini --resume ${sessionId}' },
};

/** Session ids are typed into a shell: only plain id characters are accepted (no quoting needed). */
const SAFE_ID = /^[A-Za-z0-9][\w.:-]{0,199}$/;

export interface ResumeInfo {
  agentId: string;
  sessionId: string;
  /** Agent display name ("Claude Code"). */
  agentName: string;
  /** The command to type, e.g. `claude --resume 8f3…`. */
  command: string;
}

export function resumeInfo(agentId: string, sessionId: string | undefined): ResumeInfo | null {
  const entry = RESUME[agentId];
  if (!entry || !sessionId || !SAFE_ID.test(sessionId)) return null;
  return { agentId, sessionId, agentName: entry.name, command: entry.template.replace('${sessionId}', sessionId) };
}
