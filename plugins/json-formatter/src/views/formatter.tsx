import { useOxyView } from '@oxytocin/plugin-sdk/react';
import '@oxytocin/plugin-sdk/theme.css';
import type { OxyView } from '@oxytocin/plugin-sdk';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './formatter.css';
import { format, type Indent, type JsonResult, minify } from './json-tools';

interface State {
  text: string;
  indent: Indent;
  sortKeys: boolean;
}

/** Text larger than this is not kept with the panel (the state is saved with the layout). */
const MAX_SAVED_TEXT = 200_000;
const SAVE_DEBOUNCE_MS = 300;

function Formatter({ view }: { view: OxyView<unknown, State> }) {
  // State kept with the panel (restored after a restart or a move to the right sidebar).
  const [saved] = useState(() => view.getState());
  const [text, setText] = useState(saved?.text ?? '');
  const [indent, setIndent] = useState<Indent>(saved?.indent ?? '2');
  const [sortKeys, setSortKeys] = useState(saved?.sortKeys ?? false);
  const [result, setResult] = useState<JsonResult | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const timer = setTimeout(
      () => view.setState({ text: text.length <= MAX_SAVED_TEXT ? text : '', indent, sortKeys }),
      SAVE_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [view, text, indent, sortKeys]);

  const apply = (next: JsonResult) => {
    setResult(next);
    if (next.ok) setText(next.text);
  };
  const doFormat = () => apply(format(text, { indent, sortKeys }));
  const doMinify = () => apply(minify(text, { sortKeys }));
  const copy = async () => {
    if (!text) return;
    await view.copyToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="json" data-testid="json-formatter">
      <div className="toolbar" role="toolbar" aria-label="JSON">
        <button
          type="button"
          className="primary"
          data-testid="json-format"
          onClick={doFormat}
          title="Format (Ctrl+Enter)"
        >
          Format
        </button>
        <button type="button" data-testid="json-minify" onClick={doMinify}>
          Minify
        </button>
        <select aria-label="Indentation" value={indent} onChange={(e) => setIndent(e.target.value as Indent)}>
          <option value="2">2 spaces</option>
          <option value="4">4 spaces</option>
          <option value="tab">Tabs</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={sortKeys} onChange={(e) => setSortKeys(e.target.checked)} />
          Sort keys
        </label>
        <span className="spacer" />
        <button type="button" data-testid="json-copy" onClick={() => void copy()} disabled={!text}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          data-testid="json-clear"
          onClick={() => {
            setText('');
            setResult(null);
          }}
          disabled={!text}
        >
          Clear
        </button>
      </div>
      <textarea
        data-testid="json-input"
        aria-label="JSON"
        spellCheck={false}
        placeholder='Paste JSON, e.g. {"name": "oxytocin"}'
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setResult(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            doFormat();
          }
        }}
      />
      <div
        className="status"
        data-testid="json-status"
        data-ok={result ? String(result.ok) : undefined}
        aria-live="polite"
      >
        {result === null
          ? 'Format or minify to validate.'
          : result.ok
            ? `Valid JSON · ${result.summary}`
            : `${result.line ? `Line ${result.line}, column ${result.column}: ` : ''}${result.error}`}
      </div>
    </div>
  );
}

function App() {
  const view = useOxyView<unknown, State>();
  return view ? <Formatter view={view} /> : <div className="json">Connecting…</div>;
}

createRoot(document.getElementById('root')!).render(<App />);
