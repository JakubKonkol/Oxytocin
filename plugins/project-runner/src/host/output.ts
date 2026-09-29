/** Terminal output of a running app: plain text lines, the URL it serves and a short log for agents. */

// CSI (incl. private modes), OSC (BEL or ST terminated), other two-byte escapes and stray control characters.
const ANSI =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

const LOCAL_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1?\]|\[::\]|\*|\+)$/i;
const URL_PATTERN = /\bhttps?:\/\/(?:\[[0-9a-f:]+\]|[\w.*+-]+)(?::\d{2,5})?(?:\/[^\s'"<>)\]]*)?/gi;

/** `http://0.0.0.0:8000/` → `http://localhost:8000/` (what a browser can open). */
export function browsable(url: string): string {
  return url.replace(/^(https?:\/\/)(0\.0\.0\.0|\[::\]|\*|\+)(?=[:/]|$)/i, '$1localhost').replace(/[.,;:]+$/, '');
}

/** Local URLs in a line of output (Vite's "Local:", ASP.NET's "Now listening on:", Django, …). */
export function findLocalUrls(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(URL_PATTERN)) {
    const url = m[0];
    const host = /^https?:\/\/(\[[0-9a-f:]+\]|[^/:]+)/i.exec(url)?.[1] ?? '';
    if (LOCAL_HOSTS.test(host)) out.push(browsable(url));
  }
  return out;
}

/** "listening on port 3000", "Listening on :8080", "port: 4000" without a URL. */
export function findListeningPort(line: string): number | undefined {
  const m =
    /\b(?:listening|running|started|serving|server)\b[^\n]*?(?:\bport\b\s*[:=]?\s*|:\s*)(\d{2,5})\b/i.exec(line) ??
    /\bport\s*[:=]?\s*(\d{2,5})\b.*\b(?:ready|listening|started)\b/i.exec(line);
  if (!m) return undefined;
  // Low numbers are rather times ("server restarted 10:34:15") than dev server ports.
  const port = Number(m[1]);
  return (port >= 1000 && port < 65536) || port === 80 ? port : undefined;
}

/** Last lines of plain-text output (for the UI and `get_run_logs`). */
export class LogBuffer {
  private lines: string[] = [];
  private partial = '';

  constructor(private readonly maxLines = 500) {}

  /** Adds raw output; resolves the complete lines it contained. */
  push(raw: string): string[] {
    // Cursor to column 1 (`ESC[G`, how prompt libraries redraw a line) works like a carriage return.
    // eslint-disable-next-line no-control-regex
    const text = this.partial + stripAnsi(raw.replace(/\x1b\[[01]?G/g, '\r')).replace(/\r\n/g, '\n');
    const parts = text.split('\n');
    this.partial = parts.pop() ?? '';
    // A carriage return without a newline redraws the line (progress bars): keep what was drawn last.
    const complete = parts.map((l) => l.split('\r').filter(Boolean).at(-1) ?? '');
    if (this.partial.length > 4000) {
      complete.push(this.partial);
      this.partial = '';
    }
    this.lines.push(...complete);
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
    return complete;
  }

  /** The last `count` lines (the unfinished one included). */
  tail(count: number): string[] {
    const all = this.partial ? [...this.lines, this.partial.split('\r').filter(Boolean).at(-1) ?? ''] : this.lines;
    return all.slice(-Math.max(0, count));
  }

  /** The unfinished last line as drawn (e.g. a question waiting for an answer), '' when output ended a line. */
  pending(): string {
    return this.partial.split('\r').filter(Boolean).at(-1) ?? '';
  }

  clear(): void {
    this.lines = [];
    this.partial = '';
  }
}

/** Windows cmd.exe asks this after Ctrl+C while a batch file (npm.cmd, gradlew.bat) runs. */
export const TERMINATE_BATCH_PROMPT = /Terminate batch job \(Y\/N\)\?/i;

/** A question the app asks in its terminal (e.g. "Port 4200 is already in use. Use a different port? (Y/n)"). */
export interface DetectedPrompt {
  /** The question (with the line before it when that line belongs to it). */
  text: string;
  /** Answered with yes or no. */
  yesNo: boolean;
}

const YES_NO = /[([]\s*(?:y(?:es)?\s*\/\s*n(?:o)?|n(?:o)?\s*\/\s*y(?:es)?)\s*[)\]]\s*[?:›>]?\s*$/i;
const QUESTION = [
  // "Would you like to use a different port?", "? Project name ›", "Continue? ›"
  /\?\s*[›»>:]?\s*$/,
  /^\s*[?✔✖]\s.*›\s*\S*\s*$/,
  /\(use arrow keys\)\s*$/i,
  /\bpress (?:any key|enter|return)\b.*$/i,
  /\b(?:enter|type|choose|select|provide)\b[^.]*[:>]\s*$/i,
];

/**
 * The question an app waits on: the unfinished last line of its output when it looks like a prompt (a yes/no
 * question, a line ending with "?", an interactive list). Progress output ("Building… 42%") does not count.
 */
export function detectPrompt(pendingLine: string, previousLines: readonly string[]): DetectedPrompt | undefined {
  const line = pendingLine.trim();
  if (!line || line.length > 400) return undefined;
  const yesNo = YES_NO.test(line);
  if (!yesNo && !QUESTION.some((re) => re.test(line))) return undefined;
  // Prompt libraries print a multi-line question as "? Port 4200 is already in use." + the question itself.
  const before = [...previousLines]
    .reverse()
    .find((l) => l.trim().length > 0)
    ?.trim();
  const text = before && /^[?!✖]\s/.test(before) && !/^[?!✖]\s/.test(line) ? `${before}\n${line}` : line;
  return { text: text.replace(/^[?]\s+/, ''), yesNo };
}
