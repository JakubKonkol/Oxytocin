/** Frozen evaluator data. Never copy this module or its cases into an agent checkout. */
export const corpus = [
  {
    id: 'zero-sentinel',
    initial: 'x === null ? "missing" : String(x)',
    updated: 'x === null || x === 0 ? "missing" : String(x)',
    cases: [
      [null, 'missing'],
      [0, '0'],
      [7, '7'],
    ],
    changed: [
      [0, 'missing'],
      [7, '7'],
    ],
    falseClaim: 'Zero always means missing.',
  },
  {
    id: 'tenant-key',
    initial: '[x.tenant, x.id].join(":")',
    updated: '[x.region, x.tenant, x.id].join(":")',
    cases: [
      [{ region: 'eu', tenant: 'a', id: 1 }, 'a:1'],
      [{ region: 'us', tenant: 'b', id: 1 }, 'b:1'],
    ],
    changed: [
      [{ region: 'eu', tenant: 'a', id: 1 }, 'eu:a:1'],
      [{ region: 'us', tenant: 'a', id: 1 }, 'us:a:1'],
    ],
    falseClaim: 'Entity ID alone is globally unique.',
  },
  {
    id: 'timeout-unit',
    initial: 'x * 1000',
    updated: 'x',
    cases: [
      [0, 0],
      [2, 2000],
      [0.5, 500],
    ],
    changed: [
      [2, 2],
      [0.5, 0.5],
    ],
    falseClaim: 'Timeout values are already milliseconds.',
  },
  {
    id: 'stream-lines',
    initial: 'x.join("").split("\\n").filter(Boolean)',
    updated: 'x.join("").split(/\\r?\\n/).filter(Boolean)',
    cases: [
      [
        ['a\n', 'b'],
        ['a', 'b'],
      ],
      [['', 'a\n'], ['a']],
    ],
    changed: [
      [
        ['a\r', '\nb'],
        ['a', 'b'],
      ],
      [
        ['a\n', 'b'],
        ['a', 'b'],
      ],
    ],
    falseClaim: 'Each input chunk is a complete line.',
  },
  {
    id: 'retry-method',
    initial: 'x === "GET"',
    updated: 'x === "GET" || x === "PUT"',
    cases: [
      ['GET', true],
      ['POST', false],
      ['PUT', false],
    ],
    changed: [
      ['PUT', true],
      ['POST', false],
    ],
    falseClaim: 'Every HTTP method can be retried.',
  },
  {
    id: 'path-case',
    initial: 'x.toLowerCase()',
    updated: 'x',
    cases: [
      ['API/Readme', 'api/readme'],
      ['api/readme', 'api/readme'],
    ],
    changed: [
      ['API/Readme', 'API/Readme'],
      ['api/readme', 'api/readme'],
    ],
    falseClaim: 'Case folding is always safe for paths.',
  },
  {
    id: 'entity-version',
    initial: 'String(x.id)',
    updated: '[x.id, x.version].join("@")',
    cases: [
      [{ id: 7, version: 2, name: 'new' }, '7'],
      [{ id: 8, version: 1, name: 'new' }, '8'],
    ],
    changed: [
      [{ id: 7, version: 2, name: 'new' }, '7@2'],
      [{ id: 7, version: 3, name: 'new' }, '7@3'],
    ],
    falseClaim: 'Display name is a stable entity identity.',
  },
  {
    id: 'async-result',
    initial: 'Promise.resolve(x + 1)',
    updated: 'Promise.resolve(x + 2)',
    cases: [
      [0, 1],
      [4, 5],
    ],
    changed: [
      [0, 2],
      [4, 6],
    ],
    falseClaim: 'The protocol always returns a synchronous number.',
  },
  {
    id: 'header-case',
    initial: 'Object.entries(x).find(([k]) => k.toLowerCase() === "x-request-id")?.[1] ?? null',
    updated: 'Object.entries(x).find(([k]) => k.toLowerCase() === "x-trace-id")?.[1] ?? null',
    cases: [
      [{ 'X-Request-ID': 'a' }, 'a'],
      [{}, null],
    ],
    changed: [
      [{ 'X-Trace-ID': 'b', 'x-request-id': 'old' }, 'b'],
      [{}, null],
    ],
    falseClaim: 'Header names are case sensitive.',
  },
  {
    id: 'money-scale',
    initial: 'Math.round(x * 100)',
    updated: 'Math.round(x * 1000)',
    cases: [
      [1.23, 123],
      [0, 0],
      [2.345, 235],
    ],
    changed: [
      [1.23, 1230],
      [2.345, 2345],
    ],
    falseClaim: 'Money values should be truncated to whole units.',
  },
] as const;

export const protocol = (expression: string) =>
  `// Authoritative wire protocol. Consumers must preserve its result.\nexports.apply = (x) => (${expression});\n`;
export const sessions = [
  {
    id: 'discover',
    file: 'discovery.cjs',
    prompt:
      'Implement async run(input) in discovery.cjs. Return {value: resolved protocol result}. Inspect the protocol, including edge cases. Record a reusable constraint if memory tools are available.',
  },
  {
    id: 'related',
    file: 'related.cjs',
    prompt:
      'Implement async run(input) in related.cjs. Return {result: resolved protocol result}. Preserve the authoritative wire protocol, including edge cases.',
  },
  {
    id: 'mutated',
    file: 'followup.cjs',
    prompt:
      'The protocol has been upgraded. Implement async run(input) in followup.cjs. Return {result: resolved current protocol result}. Verify assumptions against the current source.',
  },
  {
    id: 'unrelated',
    file: 'unrelated.cjs',
    prompt:
      'Implement async run(input) in unrelated.cjs. Return {normalized: input.trim().toLowerCase()}. This independent local text utility has no wire protocol dependency.',
  },
] as const;
