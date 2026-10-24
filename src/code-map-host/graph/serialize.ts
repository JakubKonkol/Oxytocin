import { createHash } from 'node:crypto';
import type { CodeMapGraph } from '@shared/domain/code-map';

const CHUNK = 2000;
const SLICE_MS = 8;
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * `JSON.stringify(graph)` plus a newline, with its SHA-256, produced in slices that yield to the event loop so a
 * large graph never blocks queries for its whole serialization. The text is byte-identical to the one-shot call.
 */
export async function serializeGraph(graph: CodeMapGraph): Promise<{ text: string; hash: string }> {
  const parts: string[] = [];
  const hash = createHash('sha256');
  const push = (text: string) => {
    parts.push(text);
    hash.update(text);
  };
  let sliceStart = performance.now();
  push('{');
  let first = true;
  for (const [key, value] of Object.entries(graph)) {
    if (value === undefined) continue;
    push(`${first ? '' : ','}${JSON.stringify(key)}:`);
    first = false;
    if (!Array.isArray(value) || value.length <= CHUNK) {
      push(JSON.stringify(value));
      continue;
    }
    push('[');
    for (let offset = 0; offset < value.length; offset += CHUNK) {
      const encoded = JSON.stringify(value.slice(offset, offset + CHUNK));
      push(`${offset ? ',' : ''}${encoded.slice(1, -1)}`);
      if (performance.now() - sliceStart > SLICE_MS) {
        await yieldToEventLoop();
        sliceStart = performance.now();
      }
    }
    push(']');
  }
  push('}\n');
  return { text: parts.join(''), hash: hash.digest('hex') };
}
