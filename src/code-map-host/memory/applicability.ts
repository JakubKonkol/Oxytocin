import { open, realpath, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import type { CodeMapGraph } from '@shared/domain/code-map';
import type { Learning, LearningDraft, MemoryAuthority } from '@shared/domain/code-map-memory';
import { builtInExclusion, matchesExclusion, resolveSourcePath, toPosix } from '../enumerate';
import { sha256 } from '../store/writer';
import { normalizedSource } from '../extract/files';

/** Evidence is inert text. No URL fetching, command execution or caller-supplied hashes. */
export async function evidenceFor(
  authority: MemoryAuthority,
  draft: LearningDraft,
  graph?: CodeMapGraph,
  verifyIndex = true,
): Promise<Learning['evidence']> {
  const root = await realpath(authority.root);
  const evidence: Learning['evidence'] = [];
  for (const reference of draft.evidence) {
    if (builtInExclusion(reference.path) || matchesExclusion(reference.path, authority.excludedPaths))
      throw new Error('INVALID_EVIDENCE: excluded path');
    const path = await resolveSourcePath(root, reference.path);
    if (matchesExclusion(toPosix(relative(root, path)), authority.excludedPaths))
      throw new Error('INVALID_EVIDENCE: excluded target');
    const indexed = graph?.files.find((f) => f.path === reference.path && f.status !== 'unsupported');
    if (
      !indexed &&
      verifyIndex &&
      !/\.(md|mdx|txt|json|jsonc|ya?ml|toml|xml|ini|cfg|csv|sql)$|(^|\/)(Dockerfile|Makefile|go\.mod|go\.work|.*\.gradle(?:\.kts)?)$/i.test(
        reference.path,
      )
    )
      throw new Error('INVALID_EVIDENCE: use an indexed source or an explicitly named document/configuration');
    const handle = await open(path, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > (indexed ? 2 * 1024 * 1024 : 256 * 1024))
        throw new Error('INVALID_EVIDENCE: file size limit');
      const bytes = Buffer.alloc(before.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const after = await stat(await resolveSourcePath(root, reference.path));
      if (
        bytesRead !== before.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        (await realpath(path)) !== path
      )
        throw new Error('EVIDENCE_CHANGED: retry after the file settles');
      const content = bytes.subarray(0, bytesRead);
      if (content.includes(0)) throw new Error('INVALID_EVIDENCE: binary file');
      const hash = sha256(content);
      if (
        verifyIndex &&
        indexed &&
        (indexed.stale ||
          indexed.status === 'failed' ||
          indexed.sha256 !== sha256(normalizedSource(content.toString('utf8'))))
      )
        throw new Error('EVIDENCE_CHANGED: wait for the indexed source generation');
      // Evidence uses whole-file bytes; structural source hashes normalize BOM and line endings.
      if (reference.symbolId) {
        const symbol = graph?.symbols.find((s) => s.id === reference.symbolId && s.file === indexed?.id);
        if (!symbol || (reference.span && JSON.stringify(reference.span) !== JSON.stringify(symbol.span)))
          throw new Error('INVALID_EVIDENCE: symbol or span is unavailable in this generation');
      }
      evidence.push({ ...reference, hash });
    } finally {
      await handle.close();
    }
  }
  return evidence;
}

/** A changed hash latches NeedsReview. Reverting a file cannot silently reactivate a finding. */
export async function checkApplicability(
  record: Learning,
  authority: MemoryAuthority,
  graph?: CodeMapGraph,
  now = Date.now(),
): Promise<boolean> {
  const previous = record.applicability[authority.checkoutId];
  if (previous && previous.state !== 'current') return false;
  let reason = '';
  if (record.checkoutId !== authority.checkoutId && record.scope !== 'project') return false;
  if (!record.evidence.length && now - Date.parse(record.reviewedAt ?? record.updatedAt) >= 30 * 86400000)
    reason = 'Unanchored finding needs review after 30 days';
  try {
    const current = await evidenceFor(authority, record, graph, false);
    if (current.some((e, i) => e.hash !== record.evidence[i]?.hash)) reason = 'Evidence changed';
  } catch {
    reason = 'Evidence unavailable or excluded';
  }
  if (reason) {
    record.applicability[authority.checkoutId] = {
      state: 'needs-review',
      checkedAt: new Date(now).toISOString(),
      reason,
    };
    return true;
  }
  if (!previous) {
    record.applicability[authority.checkoutId] = {
      state: 'current',
      checkedAt: new Date(now).toISOString(),
      reason: 'Evidence matches; claim has not been independently verified',
    };
    return true;
  }
  return false;
}
