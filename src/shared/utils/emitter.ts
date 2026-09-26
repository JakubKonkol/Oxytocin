import { type Disposable, toDisposable } from './disposable';

export type Event<T> = (listener: (value: T) => void) => Disposable;

/** Typed event emitter in the style of VS Code: `emitter.event(listener)` subscribes. */
export class Emitter<T> implements Disposable {
  private listeners = new Set<(value: T) => void>();

  readonly event: Event<T> = (listener) => {
    const wrapped = (value: T) => listener(value);
    this.listeners.add(wrapped);
    return toDisposable(() => this.listeners.delete(wrapped));
  };

  get hasListeners(): boolean {
    return this.listeners.size > 0;
  }

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
