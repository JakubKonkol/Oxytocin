export interface Command {
  id: string;
  /** "Category: Title" (docs/plan/02-ui-ux.md §12). */
  title: string;
  run: (...args: unknown[]) => unknown;
  /** Hidden from the command palette (internal commands). */
  internal?: boolean;
  /** Shown in the command palette only while this returns true (e.g. an active terminal exists). */
  when?: () => boolean;
}

const registry = new Map<string, Command>();

/** Registers a command; returns an unregister function. */
export function registerCommand(command: Command): () => void {
  registry.set(command.id, command);
  return () => {
    if (registry.get(command.id) === command) registry.delete(command.id);
  };
}

export function hasCommand(id: string): boolean {
  return registry.has(id);
}

export function getCommands(): Command[] {
  return [...registry.values()];
}

/** Commands offered by the command palette right now. */
export function paletteCommands(): Command[] {
  return getCommands().filter((c) => {
    if (c.internal) return false;
    try {
      return c.when?.() ?? true;
    } catch {
      return false;
    }
  });
}

export async function executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
  const command = registry.get(id);
  if (!command) throw new Error(`Unknown command: ${id}`);
  return await command.run(...args);
}
