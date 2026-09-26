import { useEffect } from 'react';
import { ipc } from '../../lib/ipc-client';
import { currentPlatform } from '../../lib/platform';
import { useTerminalsStore } from '../../stores/terminals-store';
import { waitingTerminals } from './attention';

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** 16×16 taskbar overlay: a warning-coloured disc with the count (Windows). */
function drawOverlay(count: number): string | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  ctx.fillStyle = cssVar('--warning');
  ctx.beginPath();
  ctx.arc(16, 16, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = cssVar('--bg-app');
  ctx.font = `bold ${count > 9 ? 16 : 22}px ${cssVar('--font-ui') || 'sans-serif'}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(count > 9 ? '9+' : String(count), 16, 17);
  return canvas.toDataURL('image/png');
}

/** Number of agents waiting for the user in all projects. */
export const useWaitingCount = () => useTerminalsStore((s) => waitingTerminals(s.terminals).length);

/** Mirrors the waiting count to the taskbar overlay / dock badge. */
export function useAttentionBadge(count: number): void {
  useEffect(() => {
    const overlay = count > 0 && currentPlatform() === 'win32' ? drawOverlay(count) : undefined;
    void ipc.invoke('window:setAttention', overlay ? { count, overlay } : { count });
  }, [count]);
}
