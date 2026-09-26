import { connect } from '@oxytocin/plugin-sdk';
import '@oxytocin/plugin-sdk/theme.css';
import './preview.css';
import { anchorTarget, replaceContent } from './render-dom';

type PreviewMessage =
  { type: 'render'; html: string; path: string; changed: boolean } | { type: 'error'; message: string };

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
  replaceContent(content, msg.html, scroller);
  renders++;
  document.body.dataset['renders'] = String(renders);
  document.body.dataset['path'] = msg.path;
}

async function main(): Promise<void> {
  const view = await connect<unknown, PreviewState>();
  view.onMessage((msg) => apply(msg as PreviewMessage));

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
    if (saved) scroller.scrollTop = Math.round(saved * (scroller.scrollHeight - scroller.clientHeight));
  } catch (e) {
    showStatus(`Could not load the preview: ${e instanceof Error ? e.message : String(e)}`);
  }
}

main().catch((e: unknown) => showStatus(`Could not connect to Oxytocin: ${String(e)}`));
