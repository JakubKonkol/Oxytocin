/**
 * Editor command templates: parsed into argv without a shell,
 * placeholders substituted per argument, so a file name can never inject commands.
 */

/** Splits a template into arguments; single or double quotes group, no escape sequences (Windows paths). */
export function parseCommandTemplate(template: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of template) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || current) args.push(current);
      current = '';
      has = false;
    } else {
      current += ch;
      has = true;
    }
  }
  if (quote) throw new Error('Unterminated quote in the editor command');
  if (has || current) args.push(current);
  return args;
}

export interface TemplateVars {
  file: string;
  line: number;
  column: number;
  projectRoot: string;
}

/** Substitutes `${file}`, `${line}`, `${column}`, `${projectRoot}` inside each argument. */
export function expandArgs(argv: readonly string[], vars: TemplateVars): string[] {
  return argv.map((arg) =>
    arg.replace(/\$\{(file|line|column|projectRoot)\}/g, (_m, key: keyof TemplateVars) => String(vars[key])),
  );
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Quotes one argument for `cmd.exe /d /s /c "<command> <args>"` (needed for `.cmd`/`.bat` launchers such as
 * `code.cmd`): MSVCRT rules for quotes and backslashes, then every cmd metacharacter escaped with `^`.
 */
export function quoteCmdArg(arg: string): string {
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\*)$/, '$1$1');
  return `"${escaped}"`.replace(CMD_META, '^$1');
}

export function quoteCmdCommand(command: string): string {
  return command.replace(CMD_META, '^$1');
}

/** The full `/c` argument for cmd.exe (used with `windowsVerbatimArguments`). */
export function cmdLine(command: string, args: readonly string[]): string {
  return `"${[quoteCmdCommand(command), ...args.map(quoteCmdArg)].join(' ')}"`;
}

/** Quoting for a command line typed into a POSIX shell or PowerShell (terminal preset). */
export function quoteForShell(arg: string, shell: 'posix' | 'pwsh' | 'cmd'): string {
  if (/^[\w@%+=:,./\\-]+$/.test(arg)) return arg;
  if (shell === 'posix') return `'${arg.replace(/'/g, `'\\''`)}'`;
  if (shell === 'pwsh') return `'${arg.replace(/'/g, "''")}'`;
  return `"${arg.replace(/"/g, '""')}"`;
}
