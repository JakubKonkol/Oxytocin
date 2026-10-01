import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import { useEffect, useMemo, useState } from 'react';
import {
  type AgentLive,
  type AgentRunState,
  type EnsembleAgent,
  ROLE_COLORS,
  type RoleColor,
  type RunStatus,
  RUN_STATUS_LABELS,
} from '@shared/domain/ensemble';
import { CLI_INFO } from '@shared/ensemble/clis';
import { formatDuration } from '@shared/ensemble/flow';
import { cn } from '../../lib/cn';
import { confirmDialogEx } from '../../stores/dialog-store';

/** A role color as a CSS variable of the project palette (tokens.css). */
export const roleColor = (color: RoleColor): string => `var(--project-${ROLE_COLORS.indexOf(color)})`;

export function AgentAvatar({
  agent,
  size = 24,
  pulse,
  className,
}: {
  agent: Pick<EnsembleAgent, 'name' | 'role'>;
  size?: number;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex flex-none items-center justify-center rounded-full font-semibold text-fg-inverse',
        pulse && 'ens-pulse',
        className,
      )}
      style={{ width: size, height: size, background: roleColor(agent.role.color), fontSize: Math.round(size * 0.45) }}
    >
      {agent.name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

/** "Opus · xhigh", "Codex · default". */
export function modelLabel(agent: EnsembleAgent): string {
  const model = agent.model?.trim() || 'default model';
  const effort = agent.effort?.trim();
  return effort ? `${model} · ${effort}` : model;
}

export const cliLabel = (agent: EnsembleAgent): string => CLI_INFO[agent.cli].displayName;

const LIVE_LABELS: Record<AgentLive | 'not-started' | 'done', string> = {
  starting: 'starting',
  working: 'working',
  idle: 'idle',
  waiting: 'waiting for you',
  unknown: 'running',
  exited: 'exited',
  'not-started': 'not started',
  done: 'done',
};

export type LiveKind = AgentLive | 'not-started' | 'done';

export function liveOf(state: AgentRunState | undefined): LiveKind {
  if (!state || state.lifecycle === 'not-started') return 'not-started';
  if (state.lifecycle === 'stopped') return 'done';
  if (state.lifecycle === 'exited') return 'exited';
  return state.live ?? 'starting';
}

export const liveLabel = (kind: LiveKind): string => LIVE_LABELS[kind];

export function LiveDot({ kind, size = 8 }: { kind: LiveKind; size?: number }) {
  return (
    <span
      role="img"
      aria-label={LIVE_LABELS[kind]}
      title={LIVE_LABELS[kind]}
      data-testid="ensemble-live-dot"
      data-state={kind}
      className="ens-dot inline-block flex-none rounded-full"
      style={{ width: size, height: size }}
    />
  );
}

const STATUS_TONE: Record<RunStatus, string> = {
  draft: 'text-fg-muted border-line',
  preparing: 'text-info border-info/40 bg-info/10',
  running: 'text-agent border-agent/40 bg-agent/10',
  paused: 'text-warning border-warning/40 bg-warning/10',
  done: 'text-success border-success/40 bg-success/10',
  failed: 'text-danger border-danger/40 bg-danger/10',
  stopped: 'text-fg-secondary border-line',
  interrupted: 'text-warning border-warning/40 bg-warning/10',
};

export function StatusPill({ status, needs }: { status: RunStatus; needs?: number }) {
  const label = needs && (status === 'running' || status === 'paused') ? 'Needs you' : RUN_STATUS_LABELS[status];
  return (
    <span
      data-testid="ensemble-status"
      data-status={status}
      className={cn(
        'inline-flex h-5 flex-none items-center gap-1.5 rounded-full border px-2 text-small font-medium',
        needs && (status === 'running' || status === 'paused')
          ? 'border-warning/40 bg-warning/10 text-warning'
          : STATUS_TONE[status],
      )}
    >
      <span
        className={cn('size-1.5 rounded-full bg-current', status === 'running' && !needs && 'ens-breathe')}
        aria-hidden
      />
      {label}
    </span>
  );
}

/** Re-renders every `ms` while `active` (elapsed times). */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

export const since = (at: number | undefined, now: number): string => (at ? formatDuration(now - at) : '');

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

/** Rendered Markdown of an agent's result (sanitized; links open in the browser). */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(md.render(text)), [text]);
  return (
    <div
      className={cn('ens-markdown', className)}
      // Sanitized above; markdown-it runs without raw HTML.
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a');
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute('href');
        if (href && /^https?:/i.test(href)) void window.oxy.invoke('shell:openExternal', { url: href });
      }}
    />
  );
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Asks for a line of text in the shared dialog (null: cancelled). */
export async function askText(o: {
  title: string;
  description?: string;
  placeholder?: string;
  confirmLabel: string;
}): Promise<string | null> {
  const r = await confirmDialogEx({
    title: o.title,
    ...(o.description ? { description: o.description } : {}),
    input: { kind: 'text', ...(o.placeholder ? { placeholder: o.placeholder } : {}) },
    confirmLabel: o.confirmLabel,
    tone: 'info',
  });
  return r.confirmed && r.value?.trim() ? r.value.trim() : null;
}

/** The settings input without its full width (for inputs that set their own width). */
export const inputSized =
  'h-7 rounded-control border border-line bg-input px-2 text-ui text-fg placeholder:text-fg-muted';
