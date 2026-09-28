/**
 * Demo data for the README screenshots: a home folder with three projects (one git repository with uncommitted
 * changes), a bash prompt, a stand-in for Claude Code and a month of Claude Code usage logs.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface DemoEnv {
  root: string;
  home: string;
  claudeDir: string;
  projects: { acmeWeb: string; paymentsApi: string; docsSite: string };
  liveSessionId: string;
}

async function put(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Jakub Konkol', '-c', 'user.email=dev@example.com', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

const ACME_FILES: Record<string, string> = {
  'package.json': `${JSON.stringify(
    {
      name: 'acme-web',
      version: '1.4.0',
      private: true,
      scripts: { dev: 'node scripts/dev-server.mjs', test: 'vitest run' },
    },
    null,
    2,
  )}\n`,
  'README.md': '# acme-web\n\nStorefront of the ACME shop.\n',
  'src/api/client.ts':
    "import axios from 'axios';\n\nexport async function post<T>(url: string, body: unknown): Promise<T> {\n  const res = await axios.post(url, body);\n  return res.data as T;\n}\n",
  'src/components/Checkout.tsx':
    "import { useCart } from '../hooks/useCart';\n\nexport function Checkout() {\n  const cart = useCart();\n  return <button>Pay {cart.total}</button>;\n}\n",
  'src/hooks/useCart.ts': 'export function useCart() {\n  return { items: [], total: 0 };\n}\n',
  'src/styles/theme.css': ':root {\n  --brand: #4f8cff;\n}\n',
  'src/legacy/analytics.ts': 'export const track = () => undefined;\n',
};

/** A dev server that looks like Vite and keeps running. */
const DEV_SERVER = `const c = (n, s) => \`\\x1b[\${n}m\${s}\\x1b[0m\`;
const t = () => new Date().toLocaleTimeString('en-US');
console.log('');
console.log(\`  \${c('1;32', 'VITE v7.3.1')}  \${c(2, 'ready in')} \${c(1, '412')} \${c(2, 'ms')}\`);
console.log('');
console.log(\`  \${c(32, '➜')}  \${c(1, 'Local')}:   \${c(36, 'http://localhost:5173/')}\`);
console.log(\`  \${c(2, '➜  Network: use --host to expose')}\`);
console.log(\`  \${c(2, '➜  press h + enter to show help')}\`);
console.log(\`\${c(2, t())} \${c('1;36', '[vite]')} \${c(32, 'hmr update')} \${c(2, '/src/api/client.ts')}\`);
console.log(\`\${c(2, t())} \${c('1;36', '[vite]')} \${c(32, 'hmr update')} \${c(2, '/src/components/Checkout.tsx')}\`);
console.log(\`\${c(2, t())} \${c('1;36', '[vite]')} \${c(32, 'page reload')} \${c(2, 'src/hooks/useCart.ts')}\`);
setInterval(() => undefined, 1 << 30);
`;

/** Stand-in for Claude Code: the \`@anthropic-ai/claude-code\` command line, a busy session and a transcript. */
function fakeClaude(sessionId: string): string {
  return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, process.pid + '.json');
fs.writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId: '${sessionId}', cwd: process.cwd(), status: 'busy', updatedAt: Date.now() }));
const cleanup = () => { try { fs.unlinkSync(file); } catch {} process.exit(0); };
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
const E = '\\x1b[';
const c = (n, s) => E + n + 'm' + s + E + '0m';
const cwd = process.cwd().replace(os.homedir(), '~');
let w = 58;
const box = (lines, color) => {
  const out = [c(color, '╭' + '─'.repeat(w) + '╮')];
  for (const l of lines) out.push(c(color, '│') + ' ' + l.text + ' '.repeat(Math.max(0, w - 1 - l.len)) + c(color, '│'));
  out.push(c(color, '╰' + '─'.repeat(w) + '╯'));
  return out.join('\\r\\n');
};
const L = (text, plain) => ({ text, len: (plain ?? text).length });
const render = () => {
w = Math.min(58, (process.stdout.columns || 80) - 2);
const out = [
  E + '2J' + E + '3J' + E + 'H',
  box([L(c('38;5;209', '✻') + ' Welcome to ' + c(1, 'Claude Code') + '!', '✻ Welcome to Claude Code!'), L(''), L(c(2, '/help for help, /status for your current setup'), '/help for help, /status for your current setup'), L(''), L(c(2, 'cwd: ' + cwd), 'cwd: ' + cwd)], '38;5;209'),
  '',
  c(2, '> ') + 'Move the checkout API client to fetch with retries, then',
  c(2, '  ') + 'add tests for useCart',
  '',
  c(1, '●') + ' I will read the client and the cart hook first.',
  '',
  c('1;32', '●') + ' ' + c(1, 'Read') + '(src/api/client.ts)',
  '  ' + c(2, '⎿  Read 84 lines'),
  '',
  c('1;32', '●') + ' ' + c(1, 'Update') + '(src/api/client.ts)',
  '  ' + c(2, '⎿  Updated src/api/client.ts (+18 −11)'),
  '       ' + c('48;5;52', ' 3 -  const res = await axios.post(url, body);          '),
  '       ' + c('48;5;22', ' 3 +  const res = await withRetry(() =>                 '),
  '       ' + c('48;5;22', ' 4 +    fetch(url, { method: "POST", body: json(body) }));'),
  '',
  c('1;32', '●') + ' ' + c(1, 'Write') + '(src/hooks/useCart.test.ts)',
  '  ' + c(2, '⎿  Wrote 46 lines to src/hooks/useCart.test.ts'),
  '',
  c('1;32', '●') + ' ' + c(1, 'Bash') + '(npm test -- useCart)',
  '  ' + c(2, '⎿  ') + c(32, '✓') + ' src/hooks/useCart.test.ts ' + c(2, '(6 tests) 38ms'),
  '',
  c('38;5;209', '✶ Refactoring checkout…') + c(2, ' (42s · ↓ 2.1k tokens · esc to interrupt)'),
  '',
  box([L(c(2, '>'), '>')], 2),
  c(2, '  ⏵⏵ accept edits on (shift+tab to cycle)'),
];
process.stdout.write(out.join('\\r\\n') + E + '?25l' + '\\x1b]9;4;3\\x1b\\\\');
};
render();
process.stdout.on('resize', render);
setInterval(() => undefined, 1 << 30);
`;
}

// Deterministic pseudo-random numbers so the screenshots are the same every run.
let seed = 42;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const between = (a: number, b: number) => Math.round(a + rand() * (b - a));

/** One Claude Code transcript with `events` assistant messages from `start` on. */
function transcript(o: { sessionId: string; cwd: string; start: number; events: number; model: string }): string {
  const lines: string[] = [];
  let ts = o.start;
  let context = between(18_000, 30_000);
  for (let i = 0; i < o.events; i++) {
    ts += between(4_000, 40_000);
    const write = between(300, 9_000);
    const usage = {
      input_tokens: between(2, 40),
      cache_creation_input_tokens: write,
      cache_read_input_tokens: context,
      output_tokens: between(80, 1_600),
      cache_creation: { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 },
    };
    context += write;
    lines.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(ts).toISOString(),
        sessionId: o.sessionId,
        uuid: randomUUID(),
        requestId: `req_${randomUUID()}`,
        cwd: o.cwd,
        message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: o.model, usage },
      }),
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function createDemo(root: string): Promise<DemoEnv> {
  await rm(root, { recursive: true, force: true });
  const home = join(root, 'home');
  const code = join(home, 'code');
  const claudeDir = join(root, 'claude');
  const projects = {
    acmeWeb: join(code, 'acme-web'),
    paymentsApi: join(code, 'payments-api'),
    docsSite: join(code, 'docs-site'),
  };

  // acme-web: a repository with a few commits and uncommitted changes.
  for (const [file, text] of Object.entries(ACME_FILES)) await put(join(projects.acmeWeb, file), text);
  await put(join(projects.acmeWeb, 'scripts/dev-server.mjs'), DEV_SERVER);
  git(projects.acmeWeb, 'init', '-q', '-b', 'main');
  git(projects.acmeWeb, 'add', '.');
  git(projects.acmeWeb, 'commit', '-q', '-m', 'feat: checkout page');
  await put(
    join(projects.acmeWeb, 'src/api/client.ts'),
    "import { withRetry } from './retry';\n\nconst json = (body: unknown) => JSON.stringify(body);\n\nexport async function post<T>(url: string, body: unknown): Promise<T> {\n  const res = await withRetry(() =>\n    fetch(url, { method: 'POST', body: json(body), headers: { 'content-type': 'application/json' } }),\n  );\n  if (!res.ok) throw new Error(`POST ${url} failed: ${res.status}`);\n  return (await res.json()) as T;\n}\n",
  );
  await put(
    join(projects.acmeWeb, 'src/api/retry.ts'),
    'export async function withRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {\n  for (let i = 1; ; i++) {\n    try {\n      return await run();\n    } catch (e) {\n      if (i >= attempts) throw e;\n      await new Promise((r) => setTimeout(r, 200 * 2 ** i));\n    }\n  }\n}\n',
  );
  await put(
    join(projects.acmeWeb, 'src/hooks/useCart.ts'),
    "import { useSyncExternalStore } from 'react';\nimport { cart } from '../store/cart';\n\nexport function useCart() {\n  return useSyncExternalStore(cart.subscribe, cart.snapshot);\n}\n",
  );
  await put(
    join(projects.acmeWeb, 'src/hooks/useCart.test.ts'),
    "import { describe, expect, it } from 'vitest';\n\ndescribe('useCart', () => {\n  it('sums the items', () => {\n    expect(1 + 1).toBe(2);\n  });\n});\n",
  );
  await put(
    join(projects.acmeWeb, 'src/components/Checkout.tsx'),
    "import { useCart } from '../hooks/useCart';\nimport { formatPrice } from '../format';\n\nexport function Checkout() {\n  const cart = useCart();\n  return <button className=\"pay\">Pay {formatPrice(cart.total)}</button>;\n}\n",
  );
  await rm(join(projects.acmeWeb, 'src/legacy/analytics.ts'));

  for (const p of [projects.paymentsApi, projects.docsSite]) {
    await put(join(p, 'README.md'), `# ${p.split('/').pop()}\n`);
    git(p, 'init', '-q', '-b', 'main');
    git(p, 'add', '.');
    git(p, 'commit', '-q', '-m', 'chore: initial commit');
  }

  const liveSessionId = randomUUID();
  const claudeCli = join(home, '.local/lib/node_modules/@anthropic-ai/claude-code/cli.js');
  await put(claudeCli, fakeClaude(liveSessionId));
  await put(
    join(home, '.bashrc'),
    [
      "PS1='\\[\\e[1;32m\\]jakub@dev\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]$ '",
      `alias claude='node ${claudeCli}'`,
      'export NPM_CONFIG_UPDATE_NOTIFIER=false',
      '',
    ].join('\n'),
  );
  // Terminals start login shells, which read ~/.bash_profile.
  await put(join(home, '.bash_profile'), '[ -r ~/.bashrc ] && . ~/.bashrc\n');

  // A month of Claude Code usage across the three projects (less on weekends), plus the live session.
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const today = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
  const weights: [string, number][] = [
    [projects.acmeWeb, 0.55],
    [projects.paymentsApi, 0.3],
    [projects.docsSite, 0.15],
  ];
  for (let d = 29; d >= 0; d--) {
    const start = today - d * day;
    const weekday = new Date(start).getDay();
    const sessions = weekday === 0 || weekday === 6 ? between(0, 2) : between(3, 6);
    for (let s = 0; s < sessions; s++) {
      const r = rand();
      const cwd =
        r < weights[0]![1] ? weights[0]![0] : r < weights[0]![1] + weights[1]![1] ? weights[1]![0] : weights[2]![0];
      const sessionStart = start + between(9, 17) * 60 * 60 * 1000 + between(0, 50) * 60_000;
      if (sessionStart > now - 30 * 60_000) continue;
      const sessionId = randomUUID();
      await put(
        join(claudeDir, 'projects', cwd.replace(/[/\\.]/g, '-'), `${sessionId}.jsonl`),
        transcript({
          sessionId,
          cwd,
          start: sessionStart,
          events: between(20, 60),
          model: rand() < 0.7 ? 'claude-opus-5-5' : 'claude-sonnet-5',
        }),
      );
    }
  }
  await put(
    join(claudeDir, 'projects', projects.acmeWeb.replace(/[/\\.]/g, '-'), `${liveSessionId}.jsonl`),
    transcript({
      sessionId: liveSessionId,
      cwd: projects.acmeWeb,
      start: now - 25 * 60_000,
      events: 30,
      model: 'claude-opus-5-5',
    }),
  );
  return { root, home, claudeDir, projects, liveSessionId };
}
