import type { Node, Tree } from 'web-tree-sitter';
import { CodeMapLimitError } from '../enumerate';
import type { FileRecord, GoRecord } from './record';
import { field, named, point, syntaxRecord } from './syntax';

const typeName = (node: Node | null): string | null => {
  if (!node) return null;
  if (['type_identifier', 'identifier', 'qualified_type'].includes(node.type)) return node.text;
  if (['pointer_type', 'generic_type', 'parenthesized_type'].includes(node.type))
    return typeName(field(node, 'type') ?? named(node)[0] ?? null);
  return null;
};
function target(node: Node | null): string[] | null {
  if (!node) return null;
  if (['identifier', 'type_identifier', 'field_identifier', 'package_identifier'].includes(node.type))
    return [node.text];
  if (node.type === 'selector_expression') {
    const left = target(field(node, 'operand')),
      right = field(node, 'field');
    return left && right ? [...left, right.text].slice(0, 20) : null;
  }
  return null;
}
const exported = (name: string) => /^\p{Lu}/u.test(name);

export function extractGo(path: string, source: string, tree: Tree): FileRecord {
  const { record, scope, emit } = syntaxRecord(path, source, tree);
  record.file.test ||= /_test\.go$/.test(path);
  const go: GoRecord = { package: '', buildTags: [], imports: [], declarations: [], locals: [], calls: [] };
  record.go = go;
  const local = (where: string, name: string, type: string | null) => {
    if (go.locals.length >= 100_000) throw new CodeMapLimitError();
    go.locals.push({ scope: where, name, type });
  };
  const parameters = (node: Node | null, where: string) => {
    let arity = 0;
    for (const parameter of named(node)) {
      const names = parameter.childrenForFieldName('name').filter((n) => n.isNamed);
      arity += Math.max(1, names.length);
      for (const name of names) local(where, name.text, typeName(field(parameter, 'type')));
    }
    return arity;
  };
  const walk = (node: Node, where: string, owner: string | null) => {
    if (node.type === 'package_clause') {
      go.package = named(node)[0]?.text ?? '';
      return;
    }
    if (node.type === 'comment') {
      if (/^\/\/\s*(go:build|\+build)\b/.test(node.text)) go.buildTags.push(node.text.slice(0, 1000));
      return;
    }
    if (node.type === 'import_spec') {
      const module = field(node, 'path')?.text.slice(1, -1);
      if (module) go.imports.push({ module, alias: field(node, 'name')?.text ?? null, at: point(node) });
      return;
    }
    if (['function_declaration', 'method_declaration'].includes(node.type)) {
      const name = field(node, 'name')?.text;
      if (!name) return;
      const receiverNode = named(field(node, 'receiver'))[0],
        receiver = receiverNode ? typeName(field(receiverNode, 'type')) : null;
      const symbol = emit(
        node,
        name,
        receiver ? 'method' : 'function',
        null,
        exported(name),
        undefined,
        receiver ? `@${receiver}` : '',
      );
      const next = scope(where, 'function', null);
      if (receiverNode) for (const n of receiverNode.childrenForFieldName('name')) local(next, n.text, receiver);
      const arity = parameters(field(node, 'parameters'), next);
      if (field(node, 'result')?.type === 'parameter_list') parameters(field(node, 'result'), next);
      go.declarations.push({
        symbol: symbol.id,
        name,
        scope: where,
        ...(receiver ? { receiver } : {}),
        parameters: arity,
      });
      const body = field(node, 'body');
      if (body) walk(body, next, symbol.id);
      return;
    }
    if (node.type === 'func_literal') {
      const next = scope(where, 'function', null);
      parameters(field(node, 'parameters'), next);
      const body = field(node, 'body');
      if (body) walk(body, next, owner);
      return;
    }
    if (['type_spec', 'type_alias'].includes(node.type)) {
      const name = field(node, 'name')?.text,
        value = field(node, 'type');
      if (!name || !value) return;
      const kind =
        value.type === 'interface_type'
          ? 'interface'
          : value.type === 'struct_type'
            ? 'struct'
            : node.type === 'type_alias'
              ? 'alias'
              : 'type';
      const symbol = emit(
        node,
        name,
        kind === 'interface' ? 'interface' : kind === 'struct' ? 'class' : 'type',
        owner,
        exported(name),
        `type ${name} ${kind === 'struct' || kind === 'interface' ? kind : value.text}`,
      );
      go.declarations.push({
        symbol: symbol.id,
        name,
        scope: where,
        typeKind: kind,
        ...(kind === 'alias' && typeName(value) ? { target: typeName(value)! } : {}),
      });
      const next = scope(where, 'class', symbol.id);
      for (const child of named(value)) walk(child, next, symbol.id);
      return;
    }
    if (['field_declaration', 'method_elem'].includes(node.type) && owner) {
      for (const name of node.childrenForFieldName('name')) {
        const symbol = emit(
          node,
          name.text,
          node.type === 'method_elem' ? 'method' : 'property',
          owner,
          exported(name.text),
        );
        go.declarations.push({ symbol: symbol.id, name: name.text, scope: where });
      }
      return;
    }
    if (['var_spec', 'const_spec'].includes(node.type)) {
      const values = named(field(node, 'value'));
      for (const [i, name] of node.childrenForFieldName('name').entries()) {
        const value = values[i];
        const type =
          typeName(field(node, 'type')) ??
          (value?.type === 'composite_literal' ? typeName(field(value, 'type')) : null);
        local(where, name.text, type);
        if (where === 'file') {
          const symbol = emit(
            node,
            name.text,
            'variable',
            null,
            exported(name.text),
            `${node.type === 'const_spec' ? 'const' : 'var'} ${name.text}${type ? ` ${type}` : ''}`,
          );
          go.declarations.push({ symbol: symbol.id, name: name.text, scope: where });
        }
      }
    }
    if (node.type === 'short_var_declaration') {
      const values = named(field(node, 'right'));
      for (const [i, name] of named(field(node, 'left')).entries()) {
        const value = values[i];
        const literal = value?.type === 'unary_expression' ? named(value)[0] : value;
        local(where, name.text, literal?.type === 'composite_literal' ? typeName(field(literal, 'type')) : null);
      }
    }
    if (node.type === 'call_expression') {
      if (go.calls.length >= 100_000) throw new CodeMapLimitError();
      go.calls.push({
        from: owner ?? record.file.id,
        scope: where,
        target: target(field(node, 'function')),
        args: named(field(node, 'arguments')).length,
        at: point(node),
      });
    }
    const next = node.type === 'block' ? scope(where, 'block', null) : where;
    for (const child of node.namedChildren) walk(child, next, owner);
  };
  walk(tree.rootNode, 'file', null);
  for (const symbol of record.symbols) {
    symbol.visibility = symbol.exported ? 'public' : 'private';
    if (go.buildTags.length) symbol.buildTags = go.buildTags;
  }
  return record;
}
