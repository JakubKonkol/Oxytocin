/** Performance marks for the start-up and interaction budgets. */
let switchStart: number | null = null;
let lastSwitchMs: number | null = null;

export function markProjectSwitchStart(): void {
  switchStart = performance.now();
}

/** Called once the target workspace is visible and painted. */
export function markProjectSwitchEnd(): void {
  if (switchStart === null) return;
  lastSwitchMs = performance.now() - switchStart;
  switchStart = null;
}

export function getLastProjectSwitchMs(): number | null {
  return lastSwitchMs;
}
