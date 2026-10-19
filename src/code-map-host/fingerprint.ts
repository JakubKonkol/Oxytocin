import { open, stat } from 'node:fs/promises';
import { MAX_SOURCE_BYTES, metadataOf, resolveSourcePath, type SourceMetadata } from './enumerate';
import { sha256 } from './store/writer';

export interface Fingerprint {
  metadata: SourceMetadata;
  sha256: string;
}
export function sameMetadata(left: SourceMetadata, right: SourceMetadata): boolean {
  return (
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.inode === right.inode &&
    left.device === right.device
  );
}

/** A bounded retry avoids publishing a hash for a different stat generation. */
export async function fingerprint(
  root: string,
  path: string,
  signal?: AbortSignal,
): Promise<{ fingerprint: Fingerprint; source: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    const absolute = await resolveSourcePath(root, path);
    const handle = await open(absolute, 'r');
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(MAX_SOURCE_BYTES))
        throw new Error('Source file exceeds the indexing limit');
      // Bound allocation even when a file grows after stat.
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await stat(await resolveSourcePath(root, path), { bigint: true });
      if (length !== Number(before.size) || !sameMetadata(metadataOf(before), metadataOf(after))) continue;
      const content = buffer.subarray(0, length);
      if (content.subarray(0, 8192).includes(0)) throw new Error('Source became binary');
      return {
        fingerprint: { metadata: metadataOf(after), sha256: sha256(content) },
        source: content.toString('utf8'),
      };
    } finally {
      await handle.close();
    }
  }
  throw new Error('Source keeps changing; retry after it settles');
}
