import type { SearchAddon } from '@xterm/addon-search';
import { ArrowDown, ArrowUp, CaseSensitive, Regex, WholeWord, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { IconButton } from '../../ui/IconButton';

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export interface TerminalSearchProps {
  search: SearchAddon;
  onClose: () => void;
}

/** Find widget (Ctrl+Shift+F): case / whole word / regex, match count, Enter / Shift+Enter, Esc closes. */
export function TerminalSearch({ search, onClose }: TerminalSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState({ query: '', caseSensitive: false, wholeWord: false, regex: false });
  const { query, caseSensitive, wholeWord, regex } = state;
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const sub = search.onDidChangeResults((e) => setResults({ index: e.resultIndex, count: e.resultCount }));
    return () => {
      sub.dispose();
      search.clearDecorations();
    };
  }, [search]);

  const options = (s: typeof state, incremental: boolean) => ({
    caseSensitive: s.caseSensitive,
    wholeWord: s.wholeWord,
    regex: s.regex,
    incremental,
    decorations: {
      matchBackground: token('--accent-muted'),
      matchOverviewRuler: token('--accent-muted'),
      activeMatchBackground: token('--accent'),
      activeMatchColorOverviewRuler: token('--accent'),
    },
  });

  const find = (direction: 'next' | 'previous', s = state, incremental = false) => {
    if (!s.query) {
      search.clearDecorations();
      setResults(null);
      return;
    }
    try {
      if (direction === 'next') search.findNext(s.query, options(s, incremental));
      else search.findPrevious(s.query, options(s, false));
    } catch {
      // invalid regex while typing
      setResults({ index: -1, count: 0 });
    }
  };

  /** Updates the query/options and re-runs the search incrementally. */
  const update = (patch: Partial<typeof state>) => {
    const next = { ...state, ...patch };
    setState(next);
    find('next', next, true);
  };

  const toggle = (active: boolean) => (active ? 'bg-accent-muted text-fg' : '');
  const summary = !query
    ? ''
    : results === null
      ? ''
      : results.count === 0
        ? 'No results'
        : `${results.index + 1} of ${results.count}`;

  return (
    <div
      data-testid="terminal-search"
      className="absolute top-2 right-4 z-10 flex items-center gap-1 rounded-control border border-line bg-elevated p-1 shadow-elevated"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          find(e.shiftKey ? 'previous' : 'next');
        }
      }}
    >
      <input
        ref={inputRef}
        aria-label="Find in terminal"
        placeholder="Find"
        value={query}
        onChange={(e) => update({ query: e.target.value })}
        className="h-6 w-48 rounded-badge border border-line bg-input px-2 text-ui text-fg outline-none focus:border-line-focus"
      />
      <IconButton
        label="Match case"
        icon={<CaseSensitive size={14} />}
        className={toggle(caseSensitive)}
        aria-pressed={caseSensitive}
        onClick={() => update({ caseSensitive: !caseSensitive })}
      />
      <IconButton
        label="Match whole word"
        icon={<WholeWord size={14} />}
        className={toggle(wholeWord)}
        aria-pressed={wholeWord}
        onClick={() => update({ wholeWord: !wholeWord })}
      />
      <IconButton
        label="Use regular expression"
        icon={<Regex size={14} />}
        className={toggle(regex)}
        aria-pressed={regex}
        onClick={() => update({ regex: !regex })}
      />
      <span
        data-testid="terminal-search-count"
        className={cn(
          'min-w-16 px-1 text-center font-mono text-small',
          results?.count === 0 ? 'text-danger' : 'text-fg-muted',
        )}
      >
        {summary}
      </span>
      <IconButton
        label="Previous match"
        shortcut="Shift+Enter"
        icon={<ArrowUp size={14} />}
        onClick={() => find('previous')}
      />
      <IconButton label="Next match" shortcut="Enter" icon={<ArrowDown size={14} />} onClick={() => find('next')} />
      <IconButton label="Close" shortcut="Escape" icon={<X size={14} />} onClick={onClose} />
    </div>
  );
}
