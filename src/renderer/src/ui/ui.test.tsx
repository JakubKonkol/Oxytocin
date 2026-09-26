import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Badge } from './Badge';
import { ConfirmDialog } from './ConfirmDialog';
import { EmptyState } from './EmptyState';
import { formatShortcut } from './Kbd';
import { ProgressBar, progressTone } from './ProgressBar';
import { SectionHeader } from './Section';
import { SplitBar } from './SplitBar';
import { StatusDot } from './StatusDot';

describe('StatusDot', () => {
  it('renders the state with an accessible label', () => {
    render(<StatusDot state="attention" testId="dot" />);
    const dot = screen.getByTestId('dot');
    expect(dot).toHaveAttribute('data-state', 'attention');
    expect(dot).toHaveAccessibleName('Needs your attention');
  });

  it('renders an empty placeholder for "none"', () => {
    const { container } = render(<StatusDot state="none" />);
    expect(container.querySelector('[data-state]')).toBeNull();
  });

  it('uses a custom title', () => {
    render(<StatusDot state="agent-working" title="Claude Code is working · 2 min" />);
    expect(screen.getByRole('img')).toHaveAccessibleName('Claude Code is working · 2 min');
  });
});

describe('ProgressBar', () => {
  it('maps values to tones', () => {
    expect(progressTone(0.5)).toBe('ok');
    expect(progressTone(0.8)).toBe('warn');
    expect(progressTone(1.2)).toBe('danger');
  });

  it('exposes progress semantics', () => {
    render(<ProgressBar value={0.64} label="64% of daily budget" />);
    const bar = screen.getByRole('progressbar', { name: '64% of daily budget' });
    expect(bar).toHaveAttribute('aria-valuenow', '64');
    expect(bar).toHaveAttribute('data-tone', 'ok');
  });
});

describe('SplitBar', () => {
  it('describes added and deleted lines', () => {
    const { container } = render(<SplitBar added={142} deleted={28} />);
    expect(screen.getByRole('img')).toHaveAccessibleName('142 lines added, 28 lines deleted');
    const added = container.querySelector<HTMLElement>('[data-part="added"]');
    expect(added?.style.width).toMatch(/^83\.5/);
  });
});

describe('formatShortcut', () => {
  it('formats for Windows/Linux and macOS', () => {
    expect(formatShortcut('Mod+Shift+B', 'win32')).toBe('Ctrl+Shift+B');
    expect(formatShortcut('Mod+Shift+B', 'darwin')).toBe('⌘⇧B');
    expect(formatShortcut('Alt+Shift+Enter', 'linux')).toBe('Alt+Shift+Enter');
  });
});

describe('Badge and EmptyState', () => {
  it('render their content', () => {
    render(
      <>
        <Badge variant="agent">AI AGENT</Badge>
        <EmptyState title="No changes since HEAD" description="All clean" />
      </>,
    );
    expect(screen.getByText('AI AGENT')).toBeInTheDocument();
    expect(screen.getByText('No changes since HEAD')).toBeInTheDocument();
    expect(screen.getByText('All clean')).toBeInTheDocument();
  });
});

describe('SectionHeader', () => {
  it('toggles on click and reflects the expanded state', async () => {
    const onToggle = vi.fn();
    render(<SectionHeader title="PROJECTS" expanded onToggle={onToggle} count={3} />);
    const button = screen.getByRole('button', { name: /PROJECTS/ });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe('ConfirmDialog', () => {
  it('focuses Cancel for destructive confirmations and calls the right callbacks', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        destructive
        title="Remove ‘api’ from Oxytocin?"
        confirmLabel="Remove"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
