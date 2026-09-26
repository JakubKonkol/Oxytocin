import DOMPurify from 'dompurify';

const HEADING_ID_PREFIX = 'user-content-';

/** Defence in depth: the backend renders trusted-ish HTML, the view still sanitizes it (docs/plan/07 §11). */
export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form'] });
}

/** Scroll ratio (0–1) of a scrolling element. */
export function scrollRatio(el: Element): number {
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? el.scrollTop / max : 0;
}

/** Replaces the content keeping the proportional scroll position. */
export function replaceContent(container: HTMLElement, html: string, scroller: Element): void {
  const ratio = scrollRatio(scroller);
  container.innerHTML = sanitize(html);
  const max = scroller.scrollHeight - scroller.clientHeight;
  scroller.scrollTop = Math.round(ratio * Math.max(0, max));
}

/** Element an in-document `#anchor` link points to. */
export function anchorTarget(doc: Document, href: string): HTMLElement | null {
  let id: string;
  try {
    id = decodeURIComponent(href.slice(1));
  } catch {
    id = href.slice(1);
  }
  if (!id) return null;
  return doc.getElementById(`${HEADING_ID_PREFIX}${id}`) ?? doc.getElementById(id);
}
