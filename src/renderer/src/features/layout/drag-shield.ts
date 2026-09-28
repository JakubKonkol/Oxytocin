let safety: ReturnType<typeof setTimeout> | undefined;

function stop(): void {
  document.body.classList.remove('oxy-dragging');
  if (safety) clearTimeout(safety);
  safety = undefined;
}

/**
 * Marks a drag so plugin iframes stop swallowing pointer events (`body.oxy-dragging iframe`); cleared when the drag
 * ends, or after 5 s as a safety net.
 */
export function shieldIframesWhileDragging(): void {
  document.body.classList.add('oxy-dragging');
  if (safety) clearTimeout(safety);
  safety = setTimeout(stop, 5000);
  for (const type of ['dragend', 'drop', 'mouseup', 'pointerup'] as const) {
    window.addEventListener(type, stop, { once: true, capture: true });
  }
}
