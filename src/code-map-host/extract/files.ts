import { posix } from 'node:path';
import { languageIdFor } from '@shared/utils/language';
import type { FileRecord } from './record';
import { EXTRACTOR_VERSION } from './record';
import { sha256 } from '../store/writer';

/** Graph content is normalized; runtime fingerprints still detect every byte change. */
export const normalizedSource = (source: string): string => source.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
export function fileRecord(path: string, source: string): FileRecord {
  const normalized = normalizedSource(source);
  const directory = posix.dirname(path);
  return {
    version: EXTRACTOR_VERSION,
    file: {
      id: `f:${path}`,
      path,
      group: `d:${directory}`,
      language: languageIdFor(path),
      bytes: Buffer.byteLength(normalized),
      lines: normalized.split('\n').length,
      sha256: sha256(normalized),
      status: 'unsupported',
      test: /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/.test(path),
    },
    symbols: [],
    scopes: [{ id: 'file', parent: null, kind: 'file', thisClass: null, staticThis: false }],
    bindings: [],
    members: [],
    imports: [],
    exports: [],
    relations: [],
    syntaxErrors: 0,
  };
}
