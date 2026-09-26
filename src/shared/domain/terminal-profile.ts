import { z } from 'zod';

export const PlatformSchema = z.enum(['win32', 'darwin', 'linux']);
export type Platform = z.infer<typeof PlatformSchema>;

export const TerminalProfileSchema = z.object({
  /** 'pwsh', 'powershell', 'cmd', 'git-bash', 'wsl:Ubuntu', 'bash', 'zsh', 'fish', 'agent:claude', 'custom:<id>' */
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['shell', 'agent']).default('shell'),
  /** Absolute path or a name resolved on PATH at spawn time. */
  file: z.string().default(''),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string().nullable()).optional(),
  icon: z.string().optional(),
  platform: z.array(PlatformSchema).optional(),
  hidden: z.boolean().optional(),
  source: z.enum(['detected', 'builtin-agent', 'user', 'plugin']).default('user'),
  /** Agent profiles: the shell profile used to run `command` (default profile when omitted). */
  shellForAgent: z.string().optional(),
  /** Agent profiles: the command typed into the shell, e.g. "claude". */
  command: z.string().optional(),
});
export type TerminalProfile = z.infer<typeof TerminalProfileSchema>;
