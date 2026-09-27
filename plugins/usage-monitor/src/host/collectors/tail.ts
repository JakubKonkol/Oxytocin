import { open, stat } from 'node:fs/promises';
import type { Database } from '../store/db';

const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

export interface Cursor {
  path: string;
  source: string;
  fileId: string | null;
  size: number;
  mtimeMs: number;
  offset: number;
  /** Collector state (JSON), e.g. Codex' last totals per session. */
  state: string | null;
}

/** `ingest_cursors` access. */
export class CursorStore {
  private readonly getStmt;
  private readonly setStmt;

  constructor(db: Database) {
    this.getStmt = db.prepare('SELECT * FROM ingest_cursors WHERE path = ?');
    this.setStmt = db.prepare(
      `INSERT INTO ingest_cursors (path, source, file_id, size, mtime_ms, offset, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET source = excluded.source, file_id = excluded.file_id, size = excluded.size,
         mtime_ms = excluded.mtime_ms, offset = excluded.offset, state = excluded.state, updated_at = excluded.updated_at`,
    );
  }

  get(path: string): Cursor | undefined {
    const row = this.getStmt.get(path) as
      | {
          path: string;
          source: string;
          file_id: string | null;
          size: number;
          mtime_ms: number;
          offset: number;
          state: string | null;
        }
      | undefined;
    return row
      ? {
          path: row.path,
          source: row.source,
          fileId: row.file_id,
          size: row.size,
          mtimeMs: row.mtime_ms,
          offset: row.offset,
          state: row.state,
        }
      : undefined;
  }

  set(c: Cursor): void {
    this.setStmt.run(c.path, c.source, c.fileId, c.size, c.mtimeMs, c.offset, c.state, Date.now());
  }
}

export interface TailBatch {
  /** Complete lines (without the newline) that passed the filter. */
  lines: Buffer[];
  /** Offset right after the last complete line of this batch (the next read starts here). */
  endOffset: number;
  /** The file was read from the start again (truncated or replaced). */
  reset: boolean;
}

export interface TailFileInfo {
  fileId: string;
  size: number;
  mtimeMs: number;
}

/** Cheap check: size, mtime and identity unchanged → nothing to read. */
export async function fileInfo(path: string): Promise<TailFileInfo> {
  const st = await stat(path, { bigint: true });
  return { fileId: `${st.dev}:${st.ino}`, size: Number(st.size), mtimeMs: Number(st.mtimeMs) };
}

export function needsRead(info: TailFileInfo, cursor: Cursor | undefined): boolean {
  return !cursor || cursor.fileId !== info.fileId || info.size !== cursor.offset;
}

/**
 * Reads a JSONL file from its cursor to the current end: complete lines only
 * (an unterminated last line waits for the next read), from the start again when the file shrank or was replaced.
 * `accept` is the fast path: lines it rejects are never decoded.
 */
export async function* tailFile(
  path: string,
  cursor: Cursor | undefined,
  accept: (line: Buffer) => boolean,
  info?: TailFileInfo,
  chunkBytes = CHUNK_BYTES,
): AsyncGenerator<TailBatch & TailFileInfo> {
  const current = info ?? (await fileInfo(path));
  let start = cursor?.offset ?? 0;
  let reset = false;
  if (cursor && (cursor.fileId !== current.fileId || current.size < cursor.offset)) {
    start = 0;
    reset = true;
  }
  if (start >= current.size) {
    if (reset || !cursor) yield { lines: [], endOffset: start, reset, ...current };
    return;
  }
  const handle = await open(path, 'r');
  try {
    let position = start;
    let carry: Buffer | null = null;
    let carryStart = start;
    while (position < current.size) {
      const length = Math.min(chunkBytes, current.size - position);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead === 0) break;
      const data: Buffer = carry ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const dataStart = carry ? carryStart : position;
      position += bytesRead;
      const lines: Buffer[] = [];
      let lineStart = 0;
      for (let i = data.indexOf(NEWLINE); i !== -1; i = data.indexOf(NEWLINE, lineStart)) {
        const line = data.subarray(lineStart, i);
        if (line.length > 0 && accept(line)) lines.push(line);
        lineStart = i + 1;
      }
      carry = lineStart < data.length ? Buffer.from(data.subarray(lineStart)) : null;
      carryStart = dataStart + lineStart;
      yield { lines, endOffset: dataStart + lineStart, reset, ...current };
      reset = false;
    }
  } finally {
    await handle.close();
  }
}
