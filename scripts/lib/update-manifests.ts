/**
 * Checks electron-builder's update manifests (latest*.yml, beta*.yml) against the packages next to them. The
 * installed apps download exactly the file names the manifests list, so a package the manifest spells differently —
 * or one GitHub renames on upload (it turns spaces into dots) — breaks every update.
 */

/** The file names a manifest points at (`files[].url` and the legacy top-level `path`). */
export function manifestFiles(yml: string): string[] {
  const names = new Set<string>();
  for (const m of yml.matchAll(/^\s*(?:-\s+)?(?:url|path):\s*(.+?)\s*$/gm)) {
    const value = m[1]!.replace(/^(['"])(.*)\1$/, '$2');
    if (value) names.add(value);
  }
  return [...names];
}

export function isUpdateManifest(name: string): boolean {
  return /^(latest|beta)(-[a-z]+)?\.yml$/.test(name);
}

/** Problems with a set of release files: manifests pointing at missing files, names GitHub would change. */
export function updateManifestProblems(files: ReadonlyMap<string, string | null>): string[] {
  const problems: string[] = [];
  for (const name of files.keys())
    if (/\s/.test(name)) problems.push(`"${name}" has a space in its name: GitHub renames it on upload.`);
  const manifests = [...files].filter(([name]) => isUpdateManifest(name));
  if (manifests.length === 0) problems.push('No update manifest (latest*.yml) was found.');
  for (const [manifest, content] of manifests) {
    const referenced = manifestFiles(content ?? '');
    if (referenced.length === 0) problems.push(`${manifest} lists no files.`);
    for (const file of referenced)
      if (!files.has(file)) problems.push(`${manifest} points at "${file}", which is not among the packages.`);
  }
  return problems;
}
