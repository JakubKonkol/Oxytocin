/** Shell families as reported by TerminalInfo.shellType. */
export type ShellKind = 'pwsh' | 'powershell' | 'cmd' | 'git-bash' | 'wsl' | 'bash' | 'zsh' | 'fish' | 'sh' | 'other';

const SAFE_POSIX = /^[\w@%+=:,./-]+$/;
const SAFE_POWERSHELL = /^[\w.:\\/=+-]+$/;
const SAFE_CMD = /^[\w.:\\/=+,@-]+$/;

const posixQuote = (arg: string) => (arg !== '' && SAFE_POSIX.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

/** fish: inside single quotes only `\` and `'` are special. */
const fishQuote = (arg: string) =>
  arg !== '' && SAFE_POSIX.test(arg) ? arg : `'${arg.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** PowerShell: single quotes, `''` for a quote. */
const powershellQuote = (arg: string) =>
  arg !== '' && SAFE_POWERSHELL.test(arg) ? arg : `'${arg.replace(/'/g, "''")}'`;

/** cmd.exe: double quotes (the CRT turns `""` inside quotes into a quote). */
const cmdQuote = (arg: string) => (arg !== '' && SAFE_CMD.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`);

/** C:\a\b → /mnt/c/a/b (a WSL shell started from Windows). */
function toWslPath(arg: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(arg);
  return m ? `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}` : arg;
}

/** Quotes one argument for the shell a command line is typed into. */
export function quoteArg(arg: string, shell: ShellKind): string {
  switch (shell) {
    case 'pwsh':
    case 'powershell':
      return powershellQuote(arg);
    case 'cmd':
      return cmdQuote(arg);
    case 'fish':
      return fishQuote(arg);
    case 'wsl':
      return posixQuote(toWslPath(arg));
    default:
      return posixQuote(arg);
  }
}

/**
 * A command line for a shell: `command` is used as typed (the user's command, e.g. `claude` or
 * `node "C:\tools\cli.js"`), the arguments are quoted for the shell. PowerShell needs the call operator when the
 * command starts with a quote.
 */
export function commandLine(command: string, args: readonly string[], shell: ShellKind): string {
  let head = command.trim();
  if ((shell === 'pwsh' || shell === 'powershell') && /^['"]/.test(head)) head = `& ${head}`;
  return [head, ...args.map((a) => quoteArg(a, shell))].join(' ');
}
