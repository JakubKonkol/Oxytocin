import type { Node, Tree } from 'web-tree-sitter';
import type { CodeMapSymbol } from '@shared/domain/code-map';
import { CodeMapLimitError } from '../enumerate';
import { fileRecord } from './files';

export const field = (node: Node, name: string) => node.childForFieldName(name);
export const named = (node: Node | null | undefined) =>
  (node?.namedChildren ?? []).filter((child) => !['comment', 'line_comment', 'block_comment'].includes(child.type));
export const point = (node: Node): [number, number] => [node.startPosition.row + 1, node.startPosition.column];
export const compact = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 4000);

/** Tree-sitter's JS binding uses UTF-16 indices/columns. Callers pass normalized source. */
export function syntaxRecord(path: string, source: string, tree: Tree) {
  const record = fileRecord(path, source);
  record.syntaxErrors = Math.max(tree.rootNode.descendantsOfType('ERROR').length, tree.rootNode.hasError ? 1 : 0);
  record.file.status = tree.rootNode.hasError ? 'syntax-errors' : 'ok';
  const counts = new Map<string, number>();
  let scopeNumber = 0;
  const scope = (parent: string, kind: 'function' | 'class' | 'block', owner: string | null) => {
    const id = `${parent}/${kind}:${++scopeNumber}`;
    record.scopes.push({ id, parent, kind, thisClass: owner, staticThis: false });
    if (record.scopes.length > 100_000) throw new CodeMapLimitError();
    return id;
  };
  const emit = (
    node: Node,
    name: string,
    kind: CodeMapSymbol['kind'],
    owner: string | null,
    exported: boolean,
    signature?: string,
    discriminator = '',
  ) => {
    const base = `s:${path}#${owner ? owner.slice(`s:${path}#`.length) + '.' : ''}${kind}:${name}${discriminator}`;
    if (base.length > 8000 || record.symbols.length >= 50_000) throw new CodeMapLimitError();
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    const body = field(node, 'body');
    const symbol: CodeMapSymbol = {
      id: count === 1 ? base : `${base}~${count}`,
      file: record.file.id,
      kind,
      name: name.slice(0, 1024),
      owner,
      exported,
      signature: compact(signature ?? source.slice(node.startIndex, body?.startIndex ?? node.endIndex)),
      span: [...point(node), node.endPosition.row + 1, node.endPosition.column],
    };
    record.symbols.push(symbol);
    return symbol;
  };
  return { record, scope, emit };
}
