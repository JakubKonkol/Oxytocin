import { describe, expect, it } from 'vitest';
import { anchorTarget, replaceContent, sanitize } from './render-dom';

describe('preview DOM helpers', () => {
  it('sanitizes scripts, handlers and javascript: links but keeps images, ids and checkboxes', () => {
    const html = sanitize(
      '<h1 id="user-content-a">A</h1><script>alert(1)</script><img src="data:image/png;base64,AQID" onerror="x()">' +
        '<a href="javascript:alert(1)">bad</a><input type="checkbox" disabled checked><style>body{}</style>',
    );
    expect(html).toContain('<h1 id="user-content-a">A</h1>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<style');
    expect(html).toContain('src="data:image/png;base64,AQID"');
    expect(html).toContain('type="checkbox"');
  });

  it('keeps the proportional scroll position when the content is replaced', () => {
    const container = document.createElement('div');
    let height = 1100;
    const scroller = {
      clientHeight: 100,
      scrollTop: 500,
      get scrollHeight() {
        return height;
      },
    } as unknown as Element;
    const original = container.innerHTML;
    // After the update the document is twice as long: the ratio (0.5) is kept.
    Object.defineProperty(container, 'innerHTML', {
      set(v: string) {
        height = 2100;
        void v;
      },
      get: () => original,
    });
    replaceContent(container, '<p>x</p>', scroller);
    expect(scroller.scrollTop).toBe(1000);
  });

  it('finds anchors with and without the user-content prefix', () => {
    document.body.innerHTML = '<h2 id="user-content-next-steps">Next</h2><div id="raw">R</div>';
    expect(anchorTarget(document, '#next-steps')?.textContent).toBe('Next');
    expect(anchorTarget(document, '#raw')?.textContent).toBe('R');
    expect(anchorTarget(document, '#')).toBeNull();
  });
});
