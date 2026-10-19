import DOMPurify from 'dompurify';
import markdownIt from 'markdown-it';

const md = markdownIt({ html: false, linkify: true, breaks: false });

/** A plan as HTML: Markdown without raw HTML, sanitized once more. */
export function renderPlan(plan: string): string {
  return DOMPurify.sanitize(md.render(plan), { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form'] });
}
