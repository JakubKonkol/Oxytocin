import { connect } from '@oxytocin/plugin-sdk';
import '@oxytocin/plugin-sdk/theme.css';
import './preview.css';
import { anchorTarget, replaceContent } from './render-dom';

type PreviewMessage =
  | { type: 'render'; html: string; path: string; changed: boolean; kind?: 'markdown' | 'code' }
  | { type: 'error'; message: string };

/** Sent by the shell when the previewed file is opened again (e.g. another `file:line` terminal link). */
interface RevealMessage {
  type: 'oxy:reveal';
  line?: number;
  column?: number;
}

interface PreviewParams {
  line?: number;
}

interface PreviewState {
  scroll?: number;
}

const content = document.getElementById('content')!;
const status = document.getElementById('status')!;
const scroller = document.scrollingElement ?? document.documentElement;
let renders = 0;

function showStatus(message: string | null): void {
  status.hidden = message === null;
  status.textContent = message ?? '';
}

function apply(msg: PreviewMessage): void {
  if (msg.type === 'error') {
    showStatus(msg.message);
    return;
  }
  showStatus(null);
  content.className = msg.kind === 'code' ? 'code-body' : 'markdown-body';
  content.dataset['kind'] = msg.kind ?? 'markdown';
  replaceContent(content, msg.html, scroller);
  if (highlighted) highlightLine(highlighted, false);
  renders++;
  document.body.dataset['renders'] = String(renders);
  document.body.dataset['path'] = msg.path;
}

let highlighted: number | undefined;

/** Marks a line of a code preview (1-based) and scrolls it into the middle of the view. */
function highlightLine(line: number, scroll = true): void {
  const lines = content.querySelectorAll<HTMLElement>('.code-view .line');
  const target = lines[Math.min(Math.max(line, 1), lines.length) - 1];
  if (!target) return;
  highlighted = line;
  for (const el of content.querySelectorAll('.line-highlight')) el.classList.remove('line-highlight');
  target.classList.add('line-highlight');
  document.body.dataset['line'] = String(line);
  if (scroll) target.scrollIntoView({ block: 'center' });
}

async function main(): Promise<void> {
  const view = await connect<PreviewParams, PreviewState>();
  view.onMessage((msg) => {
    const m = msg as PreviewMessage | RevealMessage;
    if (m.type === 'oxy:reveal') {
      if (m.line) highlightLine(m.line);
    } else apply(m);
  });

  content.addEventListener('click', (e) => {
    const link = (e.target as Element | null)?.closest('a');
    const href = link?.getAttribute('href');
    if (!link || href === null || href === undefined) return;
    e.preventDefault();
    if (href.startsWith('#')) {
      anchorTarget(document, href)?.scrollIntoView({ block: 'start' });
      return;
    }
    void view.request('openLink', { href });
  });

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener('scroll', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const max = scroller.scrollHeight - scroller.clientHeight;
      view.setState({ scroll: max > 0 ? scroller.scrollTop / max : 0 });
    }, 200);
  });

  try {
    apply(await view.request<PreviewMessage>('load'));
    const saved = view.getState()?.scroll;
    const line = view.params?.line;
    if (saved) scroller.scrollTop = Math.round(saved * (scroller.scrollHeight - scroller.clientHeight));
    if (typeof line === 'number' && line > 0) highlightLine(line, !saved);
  } catch (e) {
    showStatus(`Could not load the preview: ${e instanceof Error ? e.message : String(e)}`);
  }
}

main().catch((e: unknown) => showStatus(`Could not connect to Oxytocin: ${String(e)}`));
