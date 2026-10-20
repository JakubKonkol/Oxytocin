import type { Node, Tree } from 'web-tree-sitter';
import type { CodeMapSymbol } from '@shared/domain/code-map';
import { CodeMapLimitError } from '../enumerate';
import type { FileRecord, JavaRecord } from './record';
import { field, named, point, syntaxRecord } from './syntax';

const TYPE_KINDS: Record<string, CodeMapSymbol['kind']> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  record_declaration: 'class',
  annotation_type_declaration: 'interface',
};
const modifiers = (node: Node) =>
  named(node)
    .find((n) => n.type === 'modifiers')
    ?.text.split(/\s+/) ?? [];
const nominal = (node: Node | null) =>
  node && ['type_identifier', 'scoped_type_identifier', 'generic_type', 'array_type', 'identifier'].includes(node.type)
    ? node.text
    : null;

export function extractJava(path: string, source: string, tree: Tree): FileRecord {
  const { record, scope, emit } = syntaxRecord(path, source, tree);
  const java: JavaRecord = { package: '', imports: [], types: [], members: [], locals: [], calls: [], references: [] };
  record.java = java;
  type Context = { scope: string; owner: string | null; type: JavaRecord['types'][number] | null; static: boolean };
  const visibility = (node: Node, ctx: Context): NonNullable<CodeMapSymbol['visibility']> => {
    const list = modifiers(node);
    return list.includes('public') ||
      (ctx.type && record.symbols.find((s) => s.id === ctx.type!.symbol)?.kind === 'interface')
      ? 'public'
      : list.includes('private')
        ? 'private'
        : list.includes('protected')
          ? 'protected'
          : 'internal';
  };
  const declare = (
    node: Node,
    name: string,
    kind: CodeMapSymbol['kind'],
    ctx: Context,
    discriminator = '',
    signature?: string,
  ) => {
    const access = visibility(node, ctx),
      symbol = emit(
        node,
        name,
        kind,
        ctx.owner,
        access === 'public' || access === 'protected',
        signature,
        discriminator,
      );
    symbol.visibility = access;
    return symbol;
  };
  const local = (ctx: Context, name: string, type: string | null) => {
    if (java.locals.length >= 100_000) throw new CodeMapLimitError();
    java.locals.push({ scope: ctx.scope, name, type });
  };
  const reference = (node: Node, ctx: Context, from = ctx.owner ?? record.file.id) => {
    const name = nominal(node);
    if (!name) return;
    if (java.references.length >= 100_000) throw new CodeMapLimitError();
    java.references.push({ from, owner: ctx.type?.symbol ?? null, name, at: point(node) });
  };
  const walk = (node: Node, ctx: Context) => {
    if (node.type === 'package_declaration') {
      java.package = named(node).find((n) => ['identifier', 'scoped_identifier'].includes(n.type))?.text ?? '';
      return;
    }
    if (node.type === 'import_declaration') {
      const name = named(node).find((n) => ['identifier', 'scoped_identifier'].includes(n.type))?.text;
      if (name)
        java.imports.push({
          name,
          wildcard: node.children.some((n) => n.type === 'asterisk'),
          static: node.children.some((n) => n.type === 'static'),
          at: point(node),
        });
      return;
    }
    if (TYPE_KINDS[node.type]) {
      const name = field(node, 'name')?.text;
      if (!name) return;
      const symbol = declare(node, name, TYPE_KINDS[node.type]!, ctx);
      const type: JavaRecord['types'][number] = {
        symbol: symbol.id,
        name,
        full: `${ctx.type?.full ?? java.package}${ctx.type?.full || java.package ? '.' : ''}${name}`,
        outer: ctx.type?.symbol ?? null,
        bases: [],
      };
      for (const [fieldName, rel] of [
        ['superclass', 'extends'],
        ['interfaces', 'implements'],
      ] as const) {
        const container =
          field(node, fieldName) ??
          (node.type === 'interface_declaration'
            ? named(node).find((n) => n.type === 'extends_interfaces')
            : undefined);
        for (const child of named(container).flatMap((n) => (n.type === 'type_list' ? named(n) : [n])))
          if (nominal(child))
            type.bases.push({
              name: nominal(child)!,
              rel: node.type === 'interface_declaration' ? 'extends' : rel,
              at: point(child),
            });
      }
      java.types.push(type);
      const next: Context = { scope: scope(ctx.scope, 'class', symbol.id), owner: symbol.id, type, static: false };
      // Record components are declarations even when accessors/constructors are implicit (no invented call nodes).
      if (node.type === 'record_declaration')
        for (const p of named(field(node, 'parameters'))) {
          const nameNode = field(p, 'name');
          if (nameNode) {
            const component = emit(p, nameNode.text, 'property', symbol.id, true);
            component.visibility = 'public';
            java.members.push({
              symbol: component.id,
              owner: symbol.id,
              name: nameNode.text,
              type: nominal(field(p, 'type')),
              static: false,
              constructor: false,
              parameters: null,
              variadic: false,
            });
          }
        }
      const body = field(node, 'body');
      if (body) for (const child of named(body)) walk(child, next);
      return;
    }
    if (
      [
        'method_declaration',
        'constructor_declaration',
        'annotation_type_element_declaration',
        'compact_constructor_declaration',
      ].includes(node.type) &&
      ctx.type
    ) {
      const name = field(node, 'name')?.text ?? ctx.type.name,
        parameters = named(field(node, 'parameters'));
      const constructor = node.type.includes('constructor');
      const symbol = declare(node, name, 'method', ctx, `/${parameters.length}`),
        isStatic = modifiers(node).includes('static');
      const next: Context = {
        ...ctx,
        scope: scope(ctx.scope, 'function', ctx.type.symbol),
        owner: symbol.id,
        static: isStatic,
      };
      record.scopes[record.scopes.length - 1]!.staticThis = isStatic;
      java.members.push({
        symbol: symbol.id,
        owner: ctx.type.symbol,
        name,
        type: nominal(field(node, 'type')),
        static: isStatic,
        constructor,
        parameters: parameters.length,
        variadic: parameters.some((p) => p.type === 'spread_parameter'),
      });
      for (const p of parameters) {
        const nameNode =
          field(p, 'name') ??
          named(p)
            .find((n) => n.type === 'variable_declarator')
            ?.childForFieldName('name');
        if (nameNode)
          local(
            next,
            nameNode.text,
            nominal(field(p, 'type') ?? named(p).find((n) => n.type.includes('type')) ?? null),
          );
        const type = field(p, 'type');
        if (type) reference(type, ctx, symbol.id);
      }
      const returnType = field(node, 'type');
      if (returnType) reference(returnType, ctx, symbol.id);
      const body = field(node, 'body');
      if (body) walk(body, next);
      return;
    }
    if (['field_declaration', 'constant_declaration', 'local_variable_declaration'].includes(node.type)) {
      const type = field(node, 'type');
      for (const d of node.childrenForFieldName('declarator')) {
        const name = field(d, 'name'),
          value = field(d, 'value');
        if (!name) continue;
        const valueType =
          type?.text === 'var' && value?.type === 'object_creation_expression'
            ? nominal(field(value, 'type'))
            : nominal(type);
        if (node.type === 'local_variable_declaration') local(ctx, name.text, valueType);
        else if (ctx.type) {
          const symbol = declare(
            node,
            name.text,
            'property',
            ctx,
            '',
            `${modifiers(node).join(' ')} ${type?.text ?? ''} ${name.text}`,
          );
          java.members.push({
            symbol: symbol.id,
            owner: ctx.type.symbol,
            name: name.text,
            type: valueType,
            static: modifiers(node).includes('static') || node.type === 'constant_declaration',
            constructor: false,
            parameters: null,
            variadic: false,
          });
        }
        if (type) reference(type, ctx);
        if (value) walk(value, ctx);
      }
      return;
    }
    if (node.type === 'enum_constant' && ctx.type) {
      const name = field(node, 'name')?.text;
      if (name) {
        const symbol = emit(node, name, 'variable', ctx.type.symbol, true, name);
        symbol.visibility = 'public';
      }
      return;
    }
    if (node.type === 'lambda_expression') {
      const next = { ...ctx, scope: scope(ctx.scope, 'function', ctx.type?.symbol ?? null) };
      const params = field(node, 'parameters');
      for (const p of params?.type === 'identifier' ? [params] : named(params))
        local(next, field(p, 'name')?.text ?? p.text, nominal(field(p, 'type')));
      const body = field(node, 'body');
      if (body) walk(body, next);
      return;
    }
    if (node.type === 'method_invocation' || node.type === 'object_creation_expression') {
      if (java.calls.length >= 100_000) throw new CodeMapLimitError();
      const constructor = node.type === 'object_creation_expression',
        object = field(node, 'object');
      java.calls.push({
        from: ctx.owner ?? record.file.id,
        scope: ctx.scope,
        owner: ctx.type?.symbol ?? null,
        receiver: constructor
          ? null
          : object && ['identifier', 'scoped_identifier', 'field_access', 'this', 'super'].includes(object.type)
            ? object.text
            : object
              ? '<expression>'
              : null,
        target: constructor
          ? (nominal(field(node, 'type')) ?? '<expression>')
          : (field(node, 'name')?.text ?? '<expression>'),
        constructor,
        args: named(field(node, 'arguments')).length,
        at: point(node),
      });
      if (constructor) {
        const type = field(node, 'type');
        if (type) reference(type, ctx);
      }
    }
    const next = ['block', 'constructor_body', 'for_statement', 'enhanced_for_statement', 'catch_clause'].includes(
      node.type,
    )
      ? { ...ctx, scope: scope(ctx.scope, 'block', ctx.type?.symbol ?? null) }
      : ctx;
    if (['enhanced_for_statement', 'catch_formal_parameter'].includes(node.type)) {
      const name = field(node, 'name');
      if (name) local(next, name.text, nominal(field(node, 'type')));
    }
    for (const child of named(node)) {
      if (node.type === 'object_creation_expression' && child.type === 'class_body') continue;
      walk(child, next);
    }
  };
  walk(tree.rootNode, { scope: 'file', owner: null, type: null, static: false });
  return record;
}
