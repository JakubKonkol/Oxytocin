/** The bundled grammar that parses a path, or null for file-level indexing only. */
export function parserLanguage(path: string): string | null {
  if (/\.tsx$/.test(path)) return 'tsx';
  if (/\.[cm]?ts$/.test(path)) return 'typescript';
  if (/\.[cm]?jsx?$/.test(path)) return 'javascript';
  if (/\.cs$/.test(path)) return 'csharp';
  if (/\.go$/.test(path)) return 'go';
  return null;
}
