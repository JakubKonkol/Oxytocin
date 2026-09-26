/** Performance marks for the budgets in docs/plan/10-quality-testing-release.md §5. */
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
