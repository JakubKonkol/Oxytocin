import {
  Activity,
  AlertTriangle,
  BarChart3,
  Check,
  Circle,
  Clock,
  CreditCard,
  DollarSign,
  Flame,
  Gauge,
  Info,
  type LucideIcon,
  RefreshCw,
  XCircle,
  Zap,
} from 'lucide-react';
import { useEffect } from 'react';
import { create } from 'zustand';
import type { StatusBarItemState } from '@shared/domain/plugin';
import { cn } from '../../lib/cn';
import { ipc } from '../../lib/ipc-client';
import { usePluginsStore } from '../../stores/plugins-store';
import { runCoreCommand } from '../layout/core-commands';

/** Codicon names used in `$(name)` → icons available in the shell. */
const ICONS: Record<string, LucideIcon> = {
  graph: BarChart3,
  'graph-line': BarChart3,
  pulse: Activity,
  flame: Flame,
  dashboard: Gauge,
  check: Check,
  warning: AlertTriangle,
  error: XCircle,
  info: Info,
  sync: RefreshCw,
  clock: Clock,
  watch: Clock,
  'credit-card': CreditCard,
  zap: Zap,
  circle: Circle,
  'circle-filled': Circle,
  'debug-stackframe-dot': Circle,
  coin: DollarSign,
};

const COLORS: Record<NonNullable<StatusBarItemState['color']>, string> = {
  default: '',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  accent: 'text-accent',
};

interface StatusStore {
  items: StatusBarItemState[];
}
const useStatusStore = create<StatusStore>(() => ({ items: [] }));

let subscribed = false;
function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  ipc.on('plugins:statusBar', (items) => useStatusStore.setState({ items }));
  void ipc.invoke('plugins:statusBar').then((items) => useStatusStore.setState({ items }));
}

/** "$(graph) $4.82 today" → icon + text parts; `$(sync~spin)` spins. */
export function renderStatusText(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /\$\(([a-z0-9-]+)(~spin)?\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const Icon = ICONS[m[1]!];
    if (Icon)
      parts.push(
        <Icon
          key={`${m.index}-icon`}
          aria-hidden
          size={12}
          data-spin={m[2] ? 'true' : undefined}
          className={cn('inline-block', m[2] && 'animate-spin')}
        />,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function run(command: StatusBarItemState['command']): void {
  if (!command) return;
  const id = typeof command === 'string' ? command : command.id;
  const args = typeof command === 'string' ? [] : (command.args ?? []);
  if (id.startsWith('oxytocin.')) runCoreCommand(id, args);
  else void ipc.invoke('plugins:executeCommand', { id, args });
}

/** Declarative status bar items of plugins. */
export function PluginStatusItems({ alignment }: { alignment: 'left' | 'right' }) {
  useEffect(subscribe, []);
  const all = useStatusStore((s) => s.items);
  // Alignment and priority come from the manifest (contributes.statusBarItems); higher priority = closer to the edge.
  const declared = usePluginsStore((s) => s.contributions.statusBarItems);
  const meta = (item: StatusBarItemState) => declared.find((c) => c.pluginId === item.pluginId && c.id === item.id);
  const items = all
    .filter((i) => i.visible && i.text && (meta(i)?.alignment ?? 'right') === alignment)
    .sort((a, b) => {
      const pa = meta(a)?.priority ?? 0;
      const pb = meta(b)?.priority ?? 0;
      return alignment === 'left' ? pb - pa : pa - pb;
    });
  return (
    <>
      {items.map((item) => (
        <button
          key={`${item.pluginId}:${item.id}`}
          type="button"
          data-testid={`status-item-${item.id}`}
          title={item.tooltip}
          disabled={!item.command}
          onClick={() => run(item.command)}
          className={cn(
            'flex items-center gap-1 disabled:cursor-default enabled:hover:text-fg',
            COLORS[item.color ?? 'default'],
          )}
        >
          {renderStatusText(item.text)}
        </button>
      ))}
    </>
  );
}
