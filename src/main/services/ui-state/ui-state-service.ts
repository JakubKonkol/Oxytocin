import type { BrowserWindow, Rectangle } from 'electron';
import {
  applyUiStatePatch,
  defaultUiState,
  type UiState,
  type UiStatePatch,
  UiStateSchema,
} from '@shared/domain/ui-state';
import type { Logger } from '@shared/logging/logger';
import { JsonFileStore } from '../storage/json-file-store';

export interface DisplayLike {
  id: number;
  workArea: Rectangle;
}

/**
 * Returns window bounds that are visible on one of the current displays; otherwise centers the window
 * on the primary display (saved position from a disconnected monitor).
 */
export function resolveWindowBounds(
  state: UiState['window'],
  displays: readonly DisplayLike[],
  primary: DisplayLike,
): { x?: number; y?: number; width: number; height: number } {
  const width = Math.min(state.width, primary.workArea.width);
  const height = Math.min(state.height, primary.workArea.height);
  if (state.x === undefined || state.y === undefined) return { width, height };
  const { x, y } = state;
  const visible = displays.some((d) => {
    const a = d.workArea;
    // At least 100×50 px of the window (its title bar) must be on screen.
    return x + 100 <= a.x + a.width && x + state.width - 100 >= a.x && y >= a.y && y + 50 <= a.y + a.height;
  });
  if (visible) return { x, y, width: state.width, height: state.height };
  const a = primary.workArea;
  return { x: Math.round(a.x + (a.width - width) / 2), y: Math.round(a.y + (a.height - height) / 2), width, height };
}

export class UiStateService {
  private readonly store: JsonFileStore<UiState>;

  constructor(filePath: string, logger: Logger) {
    this.store = new JsonFileStore({
      path: filePath,
      schema: UiStateSchema,
      defaults: defaultUiState,
      debounceMs: 500,
      logger,
    });
  }

  loadSync(): UiState {
    return this.store.loadSync();
  }

  get(): UiState {
    return this.store.get();
  }

  patch(patch: UiStatePatch): UiState {
    return this.store.update((s) => applyUiStatePatch(s, patch));
  }

  /** Persists window bounds on move/resize/maximize (debounced by the store). */
  trackWindow(win: BrowserWindow, getDisplayId: () => number | undefined): void {
    const save = () => {
      if (win.isDestroyed() || win.isMinimized()) return;
      const maximized = win.isMaximized();
      const bounds = maximized ? this.store.get().window : { ...this.store.get().window, ...win.getNormalBounds() };
      const displayId = getDisplayId();
      this.store.update((s) => ({
        ...s,
        window: {
          x: Math.round(bounds.x ?? 0),
          y: Math.round(bounds.y ?? 0),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
          maximized,
          ...(displayId === undefined ? {} : { displayId }),
        },
      }));
    };
    for (const event of ['resize', 'move', 'maximize', 'unmaximize'] as const) {
      win.on(event as 'resize', save);
    }
  }

  flush(): Promise<void> {
    return this.store.flush();
  }
}
