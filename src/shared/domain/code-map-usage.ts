import { z } from 'zod';

/**
 * What Code Map costs an agent session: counts only, never query text, paths or code (FR-AG-8). The MCP Hub keeps
 * them in memory; the Usage Monitor asks for the totals of a terminal's session through the core command
 * `oxytocin.mcp.codeMapUsage` to show them next to the session's tokens and cost.
 */
export const CODE_MAP_USAGE_COMMAND = 'oxytocin.mcp.codeMapUsage';
export const CODE_MAP_USAGE_MAX_RANGES = 200;

const Count = z.number().int().nonnegative();

export const CodeMapUsageTotalsSchema = z
  .object({
    /** Code Map and learning tool calls. */
    calls: Count,
    /** Characters of the answers the agent received (what it pays for on each later turn). */
    chars: Count,
    /** Answers that carried a `stale:` line. */
    stale: Count,
    /** Answers other than OK (`INDEX_UPDATING`, `NOT_FOUND`, …). */
    notOk: Count,
    /** Calls that failed (bad arguments, no project, timeout, revoked access). */
    errors: Count,
  })
  .strict();
export type CodeMapUsageTotals = z.infer<typeof CodeMapUsageTotalsSchema>;

/** The calls one terminal made between two instants (an agent session's first and last event, with some slack). */
export const CodeMapUsageRangeSchema = z
  .object({
    key: z.string().min(1).max(200),
    terminalId: z.string().min(1).max(200),
    from: z.number().finite(),
    to: z.number().finite(),
  })
  .strict();
export type CodeMapUsageRange = z.infer<typeof CodeMapUsageRangeSchema>;

export const CodeMapUsageQuerySchema = z
  .object({ ranges: z.array(CodeMapUsageRangeSchema).max(CODE_MAP_USAGE_MAX_RANGES) })
  .strict();
export type CodeMapUsageQuery = z.infer<typeof CodeMapUsageQuerySchema>;

/** Totals by range key; a range without any call is absent. */
export const CodeMapUsageResultSchema = z.record(z.string(), CodeMapUsageTotalsSchema);
export type CodeMapUsageResult = z.infer<typeof CodeMapUsageResultSchema>;
