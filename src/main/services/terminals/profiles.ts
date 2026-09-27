import { basename } from 'node:path';
import type { Settings } from '@shared/domain/settings';
import type { TerminalProfile } from '@shared/domain/terminal-profile';
import { OxyError } from '@shared/errors';
import { detectAgentProfiles } from './shell-detect/agents';
import type { DetectDeps } from './shell-detect/deps';
import { which } from './shell-detect/deps';
import { detectPosixProfiles } from './shell-detect/posix';
import { detectWindowsProfiles } from './shell-detect/win';

export type ShellType = 'pwsh' | 'powershell' | 'cmd' | 'git-bash' | 'wsl' | 'bash' | 'zsh' | 'fish' | 'sh' | 'other';

export function shellTypeOf(profile: Pick<TerminalProfile, 'id' | 'file'>): ShellType {
  if (profile.id === 'git-bash') return 'git-bash';
  if (profile.id.startsWith('wsl:')) return 'wsl';
  const name = basename(profile.file.replace(/\\/g, '/'))
    .toLowerCase()
    .replace(/\.exe$/, '');
  switch (name) {
    case 'pwsh':
    case 'powershell':
    case 'cmd':
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'sh':
      return name;
    case 'wsl':
      return 'wsl';
    default:
      return 'other';
  }
}

export interface ResolvedLaunch {
  profile: TerminalProfile;
  file: string;
  args: string[];
  env: Record<string, string | null>;
  initialCommand?: string;
  shellType: ShellType;
}

const CACHE_MS = 60 * 60 * 1000;

function settingsKeyFor(
  platform: NodeJS.Platform,
): 'terminal.defaultProfile.windows' | 'terminal.defaultProfile.osx' | 'terminal.defaultProfile.linux' {
  if (platform === 'win32') return 'terminal.defaultProfile.windows';
  if (platform === 'darwin') return 'terminal.defaultProfile.osx';
  return 'terminal.defaultProfile.linux';
}

/** Detected + user profiles, the default profile and launch resolution. */
export class ProfileService {
  private cache: { at: number; profiles: TerminalProfile[] } | undefined;
  private inflight: Promise<TerminalProfile[]> | undefined;

  constructor(
    private readonly deps: DetectDeps,
    private readonly getSettings: () => Settings,
    private readonly now: () => number = Date.now,
    /** Profiles contributed by plugins (`contributes.terminalProfiles`). */
    private readonly pluginProfiles: () => TerminalProfile[] = () => [],
  ) {}

  private async detect(): Promise<TerminalProfile[]> {
    if (this.cache && this.now() - this.cache.at < CACHE_MS) return this.cache.profiles;
    this.inflight ??= (async () => {
      const shells =
        this.deps.platform === 'win32' ? await detectWindowsProfiles(this.deps) : await detectPosixProfiles(this.deps);
      const agents = await detectAgentProfiles(this.deps);
      const profiles = [...shells, ...agents];
      this.cache = { at: this.now(), profiles };
      return profiles;
    })().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  refresh(): void {
    this.cache = undefined;
  }

  /** All visible profiles: detected ones overridden/extended by `terminal.profiles`, minus hidden ones. */
  async list(): Promise<TerminalProfile[]> {
    const settings = this.getSettings();
    const hidden = new Set(settings['terminal.hiddenProfiles']);
    const byId = new Map<string, TerminalProfile>();
    for (const p of await this.detect()) byId.set(p.id, p);
    for (const p of this.pluginProfiles()) if (!byId.has(p.id)) byId.set(p.id, p);
    for (const p of settings['terminal.profiles']) {
      if (p.platform && !p.platform.includes(this.deps.platform as 'win32' | 'darwin' | 'linux')) continue;
      byId.set(p.id, { ...byId.get(p.id), ...p });
    }
    return [...byId.values()].filter((p) => !hidden.has(p.id) && !p.hidden);
  }

  async defaultShellProfile(): Promise<TerminalProfile> {
    const profiles = await this.list();
    const configured = this.getSettings()[settingsKeyFor(this.deps.platform)];
    const shells = profiles.filter((p) => p.kind === 'shell');
    const pick =
      (configured ? shells.find((p) => p.id === configured) : undefined) ??
      (this.deps.platform === 'win32'
        ? (shells.find((p) => p.id === 'pwsh') ?? shells.find((p) => p.id === 'powershell') ?? shells[0])
        : shells[0]);
    if (pick) return pick;
    // Nothing detected: fall back to the platform shell.
    return this.deps.platform === 'win32'
      ? { id: 'cmd', name: 'Command Prompt', kind: 'shell', file: 'cmd.exe', args: [], source: 'detected' }
      : { id: 'sh', name: 'sh', kind: 'shell', file: '/bin/sh', args: [], source: 'detected' };
  }

  /** Resolves what to spawn. Agent profiles run in a shell with the agent command typed after start. */
  async resolveLaunch(profileId: string | undefined, cwd: string): Promise<ResolvedLaunch> {
    const profiles = await this.list();
    const requested = profileId ? profiles.find((p) => p.id === profileId) : undefined;
    if (profileId && !requested) throw new OxyError('NOT_FOUND', `Terminal profile "${profileId}" not found`);
    const profile = requested ?? (await this.defaultShellProfile());
    if (profile.kind === 'agent') {
      const agent = profile;
      const shell =
        (agent.shellForAgent && profiles.find((p) => p.id === agent.shellForAgent)) ||
        (await this.defaultShellProfile());
      const initialCommand = agent.command ?? (agent.file || undefined);
      const env = { ...shell.env, ...agent.env };
      const agentProfile: TerminalProfile = {
        ...shell,
        id: agent.id,
        name: agent.name,
        kind: 'agent',
        ...(agent.icon ? { icon: agent.icon } : {}),
      };
      const shellType = shellTypeOf(shell);
      return {
        profile: agentProfile,
        file: await this.resolveFile(shell.file),
        args: this.argsFor(shell, cwd),
        env,
        ...(initialCommand ? { initialCommand } : {}),
        shellType,
      };
    }
    return {
      profile,
      file: await this.resolveFile(profile.file),
      args: this.argsFor(profile, cwd),
      env: { ...profile.env },
      shellType: shellTypeOf(profile),
    };
  }

  private argsFor(profile: TerminalProfile, cwd: string): string[] {
    // wsl.exe translates the Windows cwd itself.
    if (profile.id.startsWith('wsl:')) return [...profile.args, '--cd', cwd];
    return [...profile.args];
  }

  private async resolveFile(file: string): Promise<string> {
    if (!file) throw new OxyError('SPAWN_FAILED', 'Terminal profile has no executable');
    return (await which(file, this.deps)) ?? file;
  }
}
