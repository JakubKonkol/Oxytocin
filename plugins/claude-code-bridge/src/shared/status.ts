/** What the setup panel shows (the answer of its `status` request). */
export interface BridgeStatus {
  port: number;
  listening: boolean;
  error: string | null;
  events: number;
  lastEventAt: number | null;
  /** Claude Code lists the bridge plugin as installed (null = could not ask the `claude` CLI). */
  installed: boolean | null;
  claudeCommand: string;
  marketplaceDir: string;
}

/** Result of `install` / `uninstall`: the CLI output and the new status. */
export interface ActionResult {
  ok: boolean;
  output: string;
  status: BridgeStatus;
}
