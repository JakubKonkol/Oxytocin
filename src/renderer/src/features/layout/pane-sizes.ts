import type { PaneviewApi } from 'dockview-react';
import type { Disposable } from '@shared/utils/disposable';

/** A section of a sidebar paneview as the fitting sees it (sizes include the header). */
export interface PaneBox {
  id: string;
  expanded: boolean;
  size: number;
  min: number;
}

/**
 * The heights the expanded sections should get so they keep the proportions the user gave them (`wanted`) within
 * `total`. Collapsed sections keep their (header) size; a section without a wanted height keeps its current one.
 * Null when nothing can or needs to be fitted (no expanded section, or not even the minimum heights fit).
 */
export function fitPaneSizes(
  panes: readonly PaneBox[],
  wanted: Readonly<Record<string, number>>,
  total: number,
): number[] | null {
  const expanded = panes.filter((p) => p.expanded);
  if (expanded.length === 0 || total <= 0) return null;
  const fixed = panes.reduce((sum, p) => sum + (p.expanded ? 0 : p.size), 0);
  const available = total - fixed;
  const minimum = expanded.reduce((sum, p) => sum + p.min, 0);
  if (available < minimum) return null;
  const desired = expanded.map((p) => Math.max(p.min, wanted[p.id] ?? p.size));
  const sum = desired.reduce((a, b) => a + b, 0);
  const scaled = desired.map((d, i) => Math.max(expanded[i]!.min, Math.round((d * available) / sum)));
  // Rounding and the minimum heights: the difference goes to (or comes from) the sections from the bottom up.
  let diff = available - scaled.reduce((a, b) => a + b, 0);
  for (let i = scaled.length - 1; diff !== 0 && i >= 0; i--) {
    const next = Math.max(expanded[i]!.min, scaled[i]! + diff);
    diff -= next - scaled[i]!;
    scaled[i] = next;
  }
  let k = 0;
  return panes.map((p) => (p.expanded ? scaled[k++]! : p.size));
}

/**
 * Keeps the sections of a sidebar paneview at the heights the user gave them. dockview lays out a paneview without
 * proportions: every section added (plugin views arrive after the start) and every change of the sidebar's height
 * (the window maximized after it opened) moves only the bottom section, and the next saved layout kept that. Here
 * the heights the user chose — by dragging a sash or expanding/collapsing a section — are the source of truth: they
 * are fitted again, in proportion, whenever sections come and go or the sidebar's height changes, and they are what
 * is saved, also for sections that are not there yet (a plugin view still loading).
 */
export class PaneSizeKeeper implements Disposable {
  private wanted: Record<string, number>;
  /** Whether each section was expanded at the last look (to tell the user's toggles from sections added). */
  private expanded: Map<string, boolean>;
  private scheduled = false;
  private disposed = false;
  private readonly disposables: (() => void)[] = [];

  constructor(
    private readonly api: PaneviewApi,
    container: HTMLElement,
    initial: Readonly<Record<string, number>>,
    /** Called after the user changed the heights (the layout is then saved). */
    private readonly onUserChange: () => void,
  ) {
    this.wanted = { ...initial };
    this.expanded = this.expansion();
    const added = api.onDidAddView(() => this.schedule());
    const removed = api.onDidRemoveView(() => this.schedule());
    const layout = api.onDidLayoutChange(() => {
      // A section expanded or collapsed by the user: the heights it leaves are the new choice.
      const before = this.expanded;
      this.expanded = this.expansion();
      for (const [id, expanded] of this.expanded) {
        const was = before.get(id);
        if (was !== undefined && was !== expanded) {
          this.remember();
          return;
        }
      }
    });
    this.disposables.push(
      () => added.dispose(),
      () => removed.dispose(),
      () => layout.dispose(),
    );
    // A sash dragged by the user: the heights at its release.
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('.dv-sash')) return;
      window.addEventListener('pointerup', () => this.remember(), { once: true, capture: true });
    };
    container.addEventListener('pointerdown', onPointerDown, true);
    this.disposables.push(() => container.removeEventListener('pointerdown', onPointerDown, true));
    // The paneview's own element (PaneviewReact's root) is what dockview sizes the sections to.
    const element = container.firstElementChild instanceof HTMLElement ? container.firstElementChild : container;
    const observer = new ResizeObserver(() => {
      const { clientWidth, clientHeight } = element;
      if (clientHeight <= 0) return;
      // Laid out first (dockview's own observer may come later), then fitted.
      api.layout(clientWidth, clientHeight);
      this.apply();
    });
    observer.observe(element);
    this.disposables.push(() => observer.disconnect());
  }

  /** The heights to save: the user's choice for every section seen, present or not. */
  sizes(): Record<string, number> {
    return { ...this.wanted };
  }

  /** Forgets a section's height (closed for good). */
  forget(id: string): void {
    delete this.wanted[id];
  }

  /** Fits the sections to the wanted heights now. */
  apply(): void {
    if (this.disposed) return;
    const panels = this.api.panels;
    const total = this.api.height;
    if (panels.length === 0 || total <= 0) return;
    const boxes = panels.map((p) => ({ id: p.id, expanded: p.api.isExpanded, size: p.height, min: p.minimumSize }));
    // Sections never sized by the user keep the height they were added with.
    for (const b of boxes) if (b.expanded && this.wanted[b.id] === undefined) this.wanted[b.id] = b.size;
    const sizes = fitPaneSizes(boxes, this.wanted, total);
    if (!sizes) return;
    // Top down: each resize is taken from the sections below it, so the ones above keep their fitted height. The
    // last expanded section gets what is left.
    const lastExpanded = boxes.findLastIndex((b) => b.expanded);
    for (let i = 0; i < lastExpanded; i++) {
      const panel = panels[i]!;
      if (!boxes[i]!.expanded || Math.abs(panel.height - sizes[i]!) < 1) continue;
      panel.api.setSize({ size: sizes[i]! });
    }
  }

  private expansion(): Map<string, boolean> {
    return new Map(this.api.panels.map((p) => [p.id, p.api.isExpanded]));
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.expanded = this.expansion();
      this.apply();
    });
  }

  private remember(): void {
    if (this.disposed || this.api.height <= 0) return;
    for (const p of this.api.panels) if (p.api.isExpanded) this.wanted[p.id] = Math.round(p.height);
    this.onUserChange();
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposables.splice(0)) d();
  }
}
