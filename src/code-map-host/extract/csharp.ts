import type { Node, Tree } from 'web-tree-sitter';
import type { CodeMapSymbol } from '@shared/domain/code-map';
import { CodeMapLimitError } from '../enumerate';
import { fileRecord } from './files';
import type { CSharpRecord, CSharpTypeRef, FileRecord, Scope } from './record';

type Visibility = NonNullable<CodeMapSymbol['visibility']>;
type TypeKind = CSharpRecord['types'][number]['kind'];
type Relation = CSharpRecord['relations'][number];
interface Context {
  scope: string;
  owner: string | null;
  type: { id: string; kind: TypeKind; name: string } | null;
  namespace: string;
  container: string;
  staticThis: boolean;
  publicOwner: boolean;
}
const field = (node: Node, name: string) => node.childForFieldName(name);
const point = (node: Node): [number, number] => [node.startPosition.row + 1, node.startPosition.column];
const named = (node: Node | null | undefined) =>
  (node?.namedChildren ?? []).filter((child) => child.type !== 'comment');
function clean(node: Node | null | undefined): string {
  if (!node) return '';
  let text = node.text;
  for (const comment of node.descendantsOfType('comment').reverse())
    text = text.slice(0, comment.startIndex - node.startIndex) + ' ' + text.slice(comment.endIndex - node.startIndex);
  return text.replace(/\s+/g, ' ').trim().slice(0, 1000);
}
const ACCESS = ['public', 'protected', 'internal', 'private', 'file'];
const TYPE_DECLARATIONS: Record<string, TypeKind> = {
  class_declaration: 'class',
  struct_declaration: 'struct',
  record_declaration: 'record',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  delegate_declaration: 'delegate',
};
const BLOCK_SCOPES = new Set([
  'block',
  'for_statement',
  'foreach_statement',
  'using_statement',
  'catch_clause',
  'switch_section',
  'lambda_expression',
  'anonymous_method_expression',
]);

/** `A.B<T>.C` → `['A', 'B/1', 'C']`; `global::` is dropped. Other shapes are not names. */
export function nameSegments(node: Node | null | undefined): string[] | null {
  if (!node) return null;
  switch (node.type) {
    case 'identifier':
      return [node.text];
    case 'generic_name': {
      const identifier = named(node).find((child) => child.type === 'identifier');
      const list = named(node).find((child) => child.type === 'type_argument_list');
      return identifier ? [`${identifier.text}/${Math.max(1, named(list).length)}`] : null;
    }
    case 'qualified_name':
    case 'member_access_expression': {
      const left = nameSegments(field(node, 'qualifier') ?? field(node, 'expression'));
      const right = nameSegments(field(node, 'name'));
      return left && right ? [...left, ...right].slice(0, 32) : null;
    }
    case 'alias_qualified_name':
      return field(node, 'alias')?.text === 'global' ? nameSegments(field(node, 'name')) : null;
    default:
      return null;
  }
}
const baseName = (segment: string) => segment.replace(/\/\d+$/, '');

/** Syntax-only extraction of declarations, using directives and the declared types used for call binding. */
export function extractCSharp(path: string, source: string, tree: Tree): FileRecord {
  const record = fileRecord(path, source);
  record.syntaxErrors = Math.max(tree.rootNode.descendantsOfType('ERROR').length, tree.rootNode.hasError ? 1 : 0);
  record.file.status = tree.rootNode.hasError ? 'syntax-errors' : 'ok';
  const csharp: CSharpRecord = {
    contexts: [],
    globalUsings: { namespaces: [], statics: [], aliases: [] },
    types: [],
    members: [],
    locals: [],
    relations: [],
    topLevel: false,
  };
  record.csharp = csharp;
  const contexts = new Map<string, CSharpRecord['contexts'][number]>();
  const context = (scope: string) => {
    let entry = contexts.get(scope);
    if (!entry) {
      entry = { scope };
      contexts.set(scope, entry);
      csharp.contexts.push(entry);
    }
    return entry;
  };
  const occurrences = new Map<string, number>();
  const scopeCounts = new Map<string, number>();
  const symbolById = new Map<string, CodeMapSymbol>();
  const makeScope = (
    ctx: Context,
    kind: Scope['kind'],
    label: string,
    thisClass: string | null,
    staticThis: boolean,
  ) => {
    const base = `${ctx.scope}/${kind}:${label}`;
    const count = (scopeCounts.get(base) ?? 0) + 1;
    scopeCounts.set(base, count);
    const id = `${base}~${count}`;
    record.scopes.push({ id, parent: ctx.scope, kind, thisClass, staticThis });
    return id;
  };
  const emit = (
    node: Node,
    idName: string,
    name: string,
    kind: CodeMapSymbol['kind'],
    signature: string,
    ctx: Context,
    visibility?: Visibility,
    end: Node = node,
  ): CodeMapSymbol => {
    const ownerName = ctx.owner ? (symbolById.get(ctx.owner)?.id.slice(`s:${path}#`.length) ?? '') : '';
    const base = `s:${path}#${ownerName ? `${ownerName}.` : ''}${kind}:${idName}`;
    if (base.length > 8192)
      throw new CodeMapLimitError('Code Map symbol name or nesting limit reached — add exclusions');
    const count = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, count);
    const exported =
      !!visibility && ['public', 'protected', 'protected internal'].includes(visibility) && ctx.publicOwner;
    const symbol: CodeMapSymbol = {
      id: count === 1 ? base : `${base}~${count}`,
      file: record.file.id,
      kind,
      name: name.slice(0, 1024),
      owner: ctx.owner,
      exported,
      signature: signature.replace(/\s+/g, ' ').trim().slice(0, 4000),
      span: [...point(node), end.endPosition.row + 1, end.endPosition.column],
      ...(visibility ? { visibility } : {}),
    };
    if (record.symbols.length >= 50_000)
      throw new CodeMapLimitError('Code Map per-file symbol limit reached — add exclusions');
    record.symbols.push(symbol);
    symbolById.set(symbol.id, symbol);
    return symbol;
  };
  const relation = (node: Node, ctx: Context, entry: Omit<Relation, 'from' | 'scope' | 'at'>) => {
    if (csharp.relations.length >= 100_000)
      throw new CodeMapLimitError('Code Map per-file relation limit reached — add exclusions');
    csharp.relations.push({ from: ctx.owner ?? record.file.id, scope: ctx.scope, at: point(node), ...entry });
  };
  const modifiers = (node: Node) =>
    node.children.filter((child) => child.type === 'modifier').map((child) => child.text.trim());
  const visibilityOf = (list: string[], ctx: Context, member: boolean): Visibility => {
    const access = list.filter((value) => ACCESS.includes(value));
    if (access.includes('protected') && access.includes('internal')) return 'protected internal';
    if (access.includes('private') && access.includes('protected')) return 'private protected';
    if (access[0]) return access[0] as Visibility;
    if (ctx.type && ['interface', 'enum'].includes(ctx.type.kind)) return 'public';
    return member || ctx.type ? 'private' : 'internal';
  };
  /** The declared type as a lookup reference; arrays, tuples and predefined types have no indexed members. */
  const declaredType = (node: Node | null, scope: string): CSharpTypeRef | null => {
    if (!node) return null;
    if (['nullable_type', 'ref_type', 'scoped_type'].includes(node.type))
      return declaredType(field(node, 'type'), scope);
    const name = nameSegments(node);
    return name ? { name, scope } : null;
  };
  /** Records each named type in a type expression, including generic arguments. */
  const typeRefs = (node: Node | null, ctx: Context, syntax: Relation['syntax'] = 'type'): void => {
    if (!node) return;
    switch (node.type) {
      case 'predefined_type':
      case 'implicit_type':
        return;
      case 'identifier':
      case 'generic_name':
      case 'qualified_name':
      case 'alias_qualified_name': {
        const name = nameSegments(node);
        if (name) relation(node, ctx, { rel: 'references', target: name, syntax });
        for (const list of [node, ...node.descendantsOfType('generic_name')].flatMap((part) =>
          named(part).filter((child) => child.type === 'type_argument_list'),
        ))
          for (const argument of named(list)) typeRefs(argument, ctx);
        return;
      }
      case 'nullable_type':
      case 'pointer_type':
      case 'ref_type':
      case 'scoped_type':
        typeRefs(field(node, 'type'), ctx);
        return;
      case 'array_type':
        typeRefs(field(node, 'type'), ctx);
        visit(field(node, 'rank'), ctx);
        return;
      case 'tuple_type':
        for (const element of named(node)) typeRefs(field(element, 'type'), ctx);
        return;
      default:
        visit(node, ctx);
    }
  };
  const attributeList = (list: Node, ctx: Context) => {
    for (const attribute of named(list).filter((child) => child.type === 'attribute')) {
      const name = nameSegments(field(attribute, 'name'));
      if (name) relation(attribute, ctx, { rel: 'references', target: name, syntax: 'attribute' });
      for (const argument of named(attribute).filter((child) => child.type === 'attribute_argument_list'))
        visit(argument, ctx);
    }
  };
  const attributes = (node: Node, ctx: Context) => {
    for (const list of named(node).filter((child) => child.type === 'attribute_list')) attributeList(list, ctx);
  };
  /** Grammar quirk: `params T[] name` yields the type and name as siblings of the parameter nodes. */
  const parameters = (list: Node | null) => {
    const result: { type: Node | null; name: string | null; optional: boolean; params: boolean; text: string }[] = [];
    if (!list) return result;
    let params = false;
    for (const child of list.children) {
      if (child.type === 'params') params = true;
      if (child.type === 'parameter') {
        const mods = named(child)
          .filter((part) => part.type === 'modifier')
          .map((part) => part.text);
        const type = field(child, 'type');
        const name = field(child, 'name')?.text ?? null;
        const optional = child.children.some((part) => part.type === '=');
        result.push({
          type,
          name,
          optional,
          params: false,
          text: `${mods.length ? `${mods.join(' ')} ` : ''}${clean(type)}${type ? ' ' : ''}${name ?? ''}${optional ? ' = …' : ''}`,
        });
      } else if (params && child.type === 'array_type') {
        const name = list.children[list.children.indexOf(child) + 1];
        result.push({
          type: child,
          name: name?.type === 'identifier' ? name.text : null,
          optional: false,
          params: true,
          text: `params ${clean(child)}${name?.type === 'identifier' ? ` ${name.text}` : ''}`,
        });
        params = false;
      }
    }
    return result;
  };
  const range = (list: ReturnType<typeof parameters>): [number, number] => [
    list.filter((entry) => !entry.optional && !entry.params).length,
    list.some((entry) => entry.params) ? 1000 : list.length,
  ];
  const typeList = (list: ReturnType<typeof parameters>) =>
    list.map((entry) => clean(entry.type).replace(/\s+/g, '')).join(',');
  const addParameters = (list: ReturnType<typeof parameters>, scope: string, ctx: Context) => {
    for (const entry of list) {
      typeRefs(entry.type, ctx);
      if (entry.name)
        csharp.locals.push({
          scope,
          name: entry.name,
          type: entry.params ? null : declaredType(entry.type, scope),
        });
    }
  };
  const typeParameters = (node: Node, scope: string) => {
    const names = named(
      field(node, 'type_parameters') ?? named(node).find((c) => c.type === 'type_parameter_list') ?? null,
    )
      .map((parameter) => field(parameter, 'name')?.text ?? parameter.text)
      .slice(0, 100);
    if (names.length) context(scope).typeParameters = names;
    return names;
  };
  const constraints = (node: Node, ctx: Context) => {
    for (const clause of named(node).filter((child) => child.type === 'type_parameter_constraints_clause'))
      for (const constraint of named(clause).filter((child) => child.type === 'type_parameter_constraint'))
        for (const part of named(constraint)) typeRefs(part, ctx);
  };
  const addUsing = (node: Node, ctx: Context) => {
    const isGlobal = node.children.some((child) => child.type === 'global');
    const isStatic = node.children.some((child) => child.type === 'static');
    const alias = field(node, 'name');
    const target =
      named(node)
        .filter((child) => child.id !== alias?.id && child.type !== 'modifier')
        .at(-1) ?? null;
    const name = nameSegments(target);
    if (!name) return;
    const usings = isGlobal
      ? csharp.globalUsings
      : (context(ctx.scope).usings ??= { namespaces: [], statics: [], aliases: [] });
    if (alias) usings.aliases.push({ name: alias.text, target: name });
    else if (isStatic) usings.statics.push(name);
    else usings.namespaces.push(name.map(baseName).join('.'));
  };
  const visitNamespace = (node: Node, ctx: Context, end: Node): Context => {
    const name = (nameSegments(field(node, 'name')) ?? ['<namespace>']).map(baseName).join('.');
    const full = ctx.namespace ? `${ctx.namespace}.${name}` : name;
    const symbol = emit(node, name, name, 'namespace', `namespace ${name}`, ctx, undefined, end);
    const scope = makeScope(ctx, 'namespace', name, null, false);
    context(scope).namespace = full;
    return { ...ctx, scope, owner: symbol.id, namespace: full, container: full, type: null, publicOwner: true };
  };
  const visitType = (node: Node, ctx: Context): void => {
    const keyword = TYPE_DECLARATIONS[node.type]!;
    const kind: CodeMapSymbol['kind'] =
      keyword === 'interface' ? 'interface' : keyword === 'enum' ? 'enum' : keyword === 'delegate' ? 'type' : 'class';
    const mods = modifiers(node);
    const name = field(node, 'name')?.text ?? '<anonymous>';
    const typeParameterNodes = named(named(node).find((child) => child.type === 'type_parameter_list') ?? null);
    const arity = typeParameterNodes.length;
    const visibility = visibilityOf(mods, ctx, false);
    const declarationKeyword =
      keyword === 'record' && node.children.some((child) => child.type === 'struct')
        ? 'record struct'
        : keyword === 'record' && node.children.some((child) => child.type === 'class')
          ? 'record class'
          : keyword;
    const primary = named(node).find((child) => child.type === 'parameter_list') ?? field(node, 'parameters');
    const primaryParameters = parameters(primary);
    const bases = named(node).find((child) => child.type === 'base_list');
    const signature =
      keyword === 'delegate'
        ? `${mods.join(' ')} delegate ${clean(field(node, 'type'))} ${name}${clean(named(node).find((c) => c.type === 'type_parameter_list') ?? null)}(${primaryParameters.map((entry) => entry.text).join(', ')})`
        : `${mods.join(' ')} ${declarationKeyword} ${name}${clean(named(node).find((c) => c.type === 'type_parameter_list') ?? null)}${primary ? `(${primaryParameters.map((entry) => entry.text).join(', ')})` : ''}${
            bases
              ? ` : ${named(bases)
                  .filter((child) => child.type !== 'argument_list')
                  .map((child) => clean(field(child, 'type') ?? child))
                  .join(', ')}`
              : ''
          }`;
    const symbol = emit(node, arity ? `${name}/${arity}` : name, name, kind, signature, ctx, visibility);
    const scope = makeScope(ctx, 'class', name, symbol.id, false);
    const inner: Context = {
      ...ctx,
      scope,
      owner: symbol.id,
      type: { id: symbol.id, kind: keyword, name },
      container: ctx.container ? `${ctx.container}.${name}` : name,
      staticThis: false,
      publicOwner: symbol.exported,
    };
    typeParameters(node, scope);
    attributes(node, inner);
    const entry: CSharpRecord['types'][number] = {
      symbol: symbol.id,
      name,
      arity,
      container: ctx.container,
      outer: ctx.type?.id ?? null,
      kind: keyword,
      partial: mods.includes('partial'),
      scope,
      bases: [],
    };
    csharp.types.push(entry);
    for (const child of named(bases)) {
      if (child.type === 'argument_list') {
        relation(child, inner, {
          rel: 'calls',
          target: ['.ctor'],
          receiver: { kind: 'base' },
          args: named(child).length,
          syntax: 'new',
        });
        visit(child, inner);
        continue;
      }
      const type = child.type === 'primary_constructor_base_type' ? field(child, 'type') : child;
      const baseRef = nameSegments(type);
      if (keyword !== 'enum' && baseRef) {
        if (entry.bases.length < 100) entry.bases.push({ name: baseRef, scope, at: point(child) });
        for (const list of [type!, ...type!.descendantsOfType('generic_name')].flatMap((part) =>
          named(part).filter((part) => part.type === 'type_argument_list'),
        ))
          for (const argument of named(list)) typeRefs(argument, inner);
      }
      if (child.type === 'primary_constructor_base_type') {
        const args = named(child).find((part) => part.type === 'argument_list');
        if (args) {
          relation(args, inner, {
            rel: 'calls',
            target: ['.ctor'],
            receiver: { kind: 'base' },
            args: named(args).length,
            syntax: 'new',
          });
          visit(args, inner);
        }
      }
    }
    constraints(node, inner);
    if (keyword === 'delegate') {
      typeRefs(field(node, 'type'), inner);
      for (const entry of primaryParameters) typeRefs(entry.type, inner);
      return;
    }
    if (primary) {
      for (const parameter of primaryParameters) {
        typeRefs(parameter.type, inner);
        if (!parameter.name) continue;
        if (keyword === 'record') {
          const property = emit(
            named(primary).find((child) => field(child, 'name')?.text === parameter.name) ?? primary,
            parameter.name,
            parameter.name,
            'property',
            `public ${clean(parameter.type)} ${parameter.name} { get; init; }`,
            inner,
            'public',
          );
          csharp.members.push({
            owner: symbol.id,
            name: parameter.name,
            symbol: property.id,
            kind: 'property',
            static: false,
            type: declaredType(parameter.type, scope),
          });
        } else csharp.locals.push({ scope, name: parameter.name, type: declaredType(parameter.type, scope) });
      }
      csharp.members.push({
        owner: symbol.id,
        name: '.ctor',
        symbol: symbol.id,
        kind: 'constructor',
        static: false,
        parameters: range(primaryParameters),
        type: null,
      });
    }
    const body = field(node, 'body');
    if (body?.type === 'enum_member_declaration_list') {
      for (const member of named(body).filter((child) => child.type === 'enum_member_declaration')) {
        const memberName = field(member, 'name')?.text;
        if (!memberName) continue;
        attributes(member, inner);
        const property = emit(member, memberName, memberName, 'property', `${name}.${memberName}`, inner, 'public');
        csharp.members.push({
          owner: symbol.id,
          name: memberName,
          symbol: property.id,
          kind: 'enum-member',
          static: true,
          type: null,
        });
        const value = field(member, 'value');
        if (value) visit(value, { ...inner, owner: property.id });
      }
      return;
    }
    for (const child of named(body)) visit(child, inner);
  };
  const visitFunctionBody = (node: Node, ctx: Context, symbolId: string, scope: string, isStatic: boolean) => {
    const inner = { ...ctx, scope, owner: symbolId, staticThis: isStatic, publicOwner: false };
    for (const name of ['body', 'value']) {
      const body = field(node, name);
      if (body) visit(body, inner);
    }
    const initializer = named(node).find((child) => child.type === 'constructor_initializer');
    if (initializer) {
      const args = named(initializer).find((child) => child.type === 'argument_list');
      relation(initializer, inner, {
        rel: 'calls',
        target: ['.ctor'],
        receiver: { kind: initializer.children.some((child) => child.type === 'base') ? 'base' : 'this' },
        args: named(args).length,
        syntax: 'new',
      });
      if (args) visit(args, inner);
    }
  };
  const visitMethod = (node: Node, ctx: Context): void => {
    const mods = modifiers(node);
    const isStatic = mods.includes('static') || mods.includes('const');
    const explicit = named(node).find((child) => child.type === 'explicit_interface_specifier');
    const explicitName = explicit ? clean(named(explicit)[0] ?? null) : '';
    const list = parameters(field(node, 'parameters'));
    let name: string;
    let memberKind: CSharpRecord['members'][number]['kind'] | null;
    let returns: Node | null = null;
    switch (node.type) {
      case 'constructor_declaration':
        name = field(node, 'name')?.text ?? ctx.type?.name ?? '.ctor';
        memberKind = isStatic ? null : 'constructor';
        break;
      case 'destructor_declaration':
        name = `~${field(node, 'name')?.text ?? ctx.type?.name ?? ''}`;
        memberKind = null;
        break;
      case 'operator_declaration':
        name = `operator ${field(node, 'operator')?.text ?? ''}`;
        returns = field(node, 'type');
        memberKind = 'operator';
        break;
      case 'conversion_operator_declaration':
        name = `${node.children.find((child) => ['implicit', 'explicit'].includes(child.type))?.type ?? ''} operator ${clean(field(node, 'type'))}`;
        returns = field(node, 'type');
        memberKind = 'operator';
        break;
      default:
        name = field(node, 'name')?.text ?? '<method>';
        returns = field(node, 'returns') ?? field(node, 'type');
        memberKind = explicit ? null : 'method';
    }
    const typeParameterNode = named(node).find((child) => child.type === 'type_parameter_list') ?? null;
    const arity = named(typeParameterNode).length;
    const local = node.type === 'local_function_statement';
    const idName = `${explicitName ? `${explicitName}.` : ''}${name}${arity ? `/${arity}` : ''}(${typeList(list)})`;
    const visibility = local ? undefined : explicit ? 'private' : visibilityOf(mods, ctx, true);
    const signature = `${mods.join(' ')} ${clean(returns)} ${explicitName ? `${explicitName}.` : ''}${name}${clean(typeParameterNode)}(${list.map((entry) => entry.text).join(', ')})`;
    const symbol = emit(node, idName, name, local ? 'function' : 'method', signature, ctx, visibility);
    const scope = makeScope(ctx, 'function', name, ctx.type?.id ?? null, isStatic || (local && ctx.staticThis));
    const inner = { ...ctx, scope, owner: symbol.id };
    typeParameters(node, scope);
    attributes(node, inner);
    typeRefs(returns, inner);
    constraints(node, inner);
    addParameters(list, scope, inner);
    if (local)
      csharp.locals.push({
        scope: ctx.scope,
        name,
        type: declaredType(returns, scope),
        symbol: symbol.id,
        parameters: range(list),
      });
    else if (memberKind && ctx.type)
      csharp.members.push({
        owner: ctx.type.id,
        name: memberKind === 'constructor' ? '.ctor' : name,
        symbol: symbol.id,
        kind: memberKind,
        static: isStatic,
        parameters: range(list),
        type: declaredType(returns, scope),
      });
    visitFunctionBody(node, ctx, symbol.id, scope, isStatic || (local && ctx.staticThis));
  };
  const visitProperty = (node: Node, ctx: Context): void => {
    const mods = modifiers(node);
    const isStatic = mods.includes('static');
    const type = field(node, 'type');
    const explicit = named(node).find((child) => child.type === 'explicit_interface_specifier');
    const explicitName = explicit ? clean(named(explicit)[0] ?? null) : '';
    const indexer = node.type === 'indexer_declaration';
    const list = indexer ? parameters(field(node, 'parameters')) : [];
    const name = indexer ? 'this' : (field(node, 'name')?.text ?? '<property>');
    const accessors = named(field(node, 'accessors')).filter((child) => child.type === 'accessor_declaration');
    const accessorText = accessors.length
      ? `{ ${accessors
          .map(
            (accessor) =>
              `${modifiers(accessor)
                .map((value) => `${value} `)
                .join('')}${field(accessor, 'name')?.text ?? ''};`,
          )
          .join(' ')} }`
      : '{ get; }';
    const visibility = explicit ? 'private' : visibilityOf(mods, ctx, true);
    const keyword = node.type === 'event_declaration' ? 'event ' : '';
    const symbol = emit(
      node,
      `${explicitName ? `${explicitName}.` : ''}${indexer ? `this[${typeList(list)}]` : name}`,
      name,
      'property',
      `${mods.join(' ')} ${keyword}${clean(type)} ${explicitName ? `${explicitName}.` : ''}${indexer ? `this[${list.map((entry) => entry.text).join(', ')}]` : name} ${accessorText}`,
      ctx,
      visibility,
    );
    const scope = makeScope(ctx, 'function', name, ctx.type?.id ?? null, isStatic);
    const inner = { ...ctx, scope, owner: symbol.id, staticThis: isStatic, publicOwner: false };
    attributes(node, inner);
    typeRefs(type, inner);
    addParameters(list, scope, inner);
    if (!explicit && ctx.type)
      csharp.members.push({
        owner: ctx.type.id,
        name,
        symbol: symbol.id,
        kind: indexer ? 'indexer' : node.type === 'event_declaration' ? 'event' : 'property',
        static: isStatic,
        type: declaredType(type, ctx.scope),
      });
    csharp.locals.push({ scope, name: 'value', type: declaredType(type, ctx.scope) });
    for (const accessor of accessors) {
      attributes(accessor, inner);
      const body = field(accessor, 'body');
      if (body) visit(body, inner);
    }
    for (const name of ['value']) {
      const body = field(node, name);
      if (body) visit(body, inner);
    }
  };
  const visitField = (node: Node, ctx: Context): void => {
    const mods = modifiers(node);
    const isStatic = mods.includes('static') || mods.includes('const');
    const declaration = named(node).find((child) => child.type === 'variable_declaration');
    const type = declaration ? field(declaration, 'type') : null;
    const visibility = visibilityOf(mods, ctx, true);
    const event = node.type === 'event_field_declaration';
    let first: CodeMapSymbol | null = null;
    for (const declarator of named(declaration).filter((child) => child.type === 'variable_declarator')) {
      const name = field(declarator, 'name')?.text;
      if (!name) continue;
      const symbol = emit(
        declarator,
        name,
        name,
        'property',
        `${mods.join(' ')} ${event ? 'event ' : ''}${clean(type)} ${name}`,
        ctx,
        visibility,
      );
      first ??= symbol;
      if (ctx.type)
        csharp.members.push({
          owner: ctx.type.id,
          name,
          symbol: symbol.id,
          kind: event ? 'event' : 'field',
          static: isStatic,
          type: declaredType(type, ctx.scope),
        });
      const inner = { ...ctx, owner: symbol.id, staticThis: isStatic, publicOwner: false };
      for (const child of named(declarator)) if (child.id !== field(declarator, 'name')?.id) visit(child, inner);
    }
    if (first) {
      const inner = { ...ctx, owner: first.id, staticThis: isStatic, publicOwner: false };
      attributes(node, inner);
      typeRefs(type, inner);
    }
  };
  const local = (ctx: Context, name: Node | null, type: CSharpTypeRef | null) => {
    if (name?.type === 'identifier') csharp.locals.push({ scope: ctx.scope, name: name.text, type });
  };
  const inferred = (value: Node | null, scope: string): CSharpTypeRef | null => {
    if (!value) return null;
    if (value.type === 'object_creation_expression' || value.type === 'cast_expression')
      return declaredType(field(value, 'type'), scope);
    if (value.type === 'as_expression') return declaredType(field(value, 'right'), scope);
    return null;
  };
  const visitInvocation = (node: Node, ctx: Context): void => {
    const fn = field(node, 'function');
    const args = field(node, 'arguments');
    const count = named(args).filter((child) => child.type === 'argument').length;
    if (fn?.type === 'identifier' && fn.text === 'nameof' && count === 1) {
      const name = nameSegments(named(named(args)[0] ?? null)[0] ?? null);
      if (name) relation(node, ctx, { rel: 'references', target: name, syntax: 'nameof' });
      return;
    }
    let receiver: NonNullable<Relation['receiver']> = { kind: 'none' };
    let member: Node | null = fn;
    let rest: Node | null = null;
    if (fn?.type === 'member_access_expression' || fn?.type === 'conditional_access_expression') {
      const expression = fn.type === 'member_access_expression' ? field(fn, 'expression') : field(fn, 'condition');
      member =
        fn.type === 'member_access_expression'
          ? field(fn, 'name')
          : (field(named(fn).find((child) => child.type === 'member_binding_expression') ?? fn, 'name') ?? null);
      const name = nameSegments(expression);
      if (expression?.type === 'this' || expression?.type === 'this_expression') receiver = { kind: 'this' };
      else if (expression?.type === 'base' || expression?.type === 'base_expression') receiver = { kind: 'base' };
      else if (name) receiver = { kind: 'name', name };
      else if (expression?.type === 'object_creation_expression' && nameSegments(field(expression, 'type')))
        receiver = { kind: 'new', type: nameSegments(field(expression, 'type'))! };
      else receiver = { kind: 'expression' };
      if (receiver.kind === 'expression' || receiver.kind === 'new') rest = expression;
      else if (expression) typeArguments(expression, ctx);
    }
    const target = nameSegments(member);
    if (target?.length === 1 && member) {
      relation(node, ctx, { rel: 'calls', target: [baseName(target[0]!)], receiver, args: count, syntax: 'call' });
      typeArguments(member, ctx);
    } else if (fn && !rest) rest = fn;
    if (rest) visit(rest, ctx);
    if (args) visit(args, ctx);
  };
  const typeArguments = (node: Node, ctx: Context) => {
    for (const list of [node, ...node.descendantsOfType('generic_name')].flatMap((part) =>
      named(part).filter((child) => child.type === 'type_argument_list'),
    ))
      for (const argument of named(list)) typeRefs(argument, ctx);
  };
  const visit = (node: Node | null, ctx: Context): void => {
    if (!node || node.type === 'comment') return;
    if (TYPE_DECLARATIONS[node.type]) return visitType(node, ctx);
    switch (node.type) {
      case 'compilation_unit': {
        let current = ctx;
        let topLevel: Context | null = null;
        for (const child of named(node)) {
          if (child.type === 'file_scoped_namespace_declaration') {
            current = visitNamespace(child, current, node);
            continue;
          }
          if (child.type === 'global_statement') {
            csharp.topLevel = true;
            topLevel ??= {
              ...current,
              scope: makeScope(current, 'function', '<top-level>', null, true),
              staticThis: true,
            };
            for (const statement of named(child)) visit(statement, topLevel);
            continue;
          }
          visit(child, current);
        }
        return;
      }
      case 'namespace_declaration': {
        const inner = visitNamespace(node, ctx, node);
        for (const child of named(field(node, 'body'))) visit(child, inner);
        return;
      }
      case 'using_directive':
        return addUsing(node, ctx);
      case 'method_declaration':
      case 'constructor_declaration':
      case 'destructor_declaration':
      case 'operator_declaration':
      case 'conversion_operator_declaration':
      case 'local_function_statement':
        return visitMethod(node, ctx);
      case 'property_declaration':
      case 'indexer_declaration':
      case 'event_declaration':
        return visitProperty(node, ctx);
      case 'field_declaration':
      case 'event_field_declaration':
        return visitField(node, ctx);
      case 'attribute_list':
        return attributeList(node, ctx);
      case 'invocation_expression':
        return visitInvocation(node, ctx);
      case 'object_creation_expression': {
        const type = field(node, 'type');
        const name = nameSegments(type);
        const args = field(node, 'arguments');
        if (name)
          relation(node, ctx, {
            rel: 'calls',
            target: name,
            receiver: { kind: 'none' },
            args: named(args).filter((child) => child.type === 'argument').length,
            syntax: 'new',
          });
        if (type) typeArguments(type, ctx);
        if (!name) typeRefs(type, ctx);
        for (const child of named(node)) if (child.id !== type?.id) visit(child, ctx);
        return;
      }
      case 'variable_declaration': {
        const type = field(node, 'type');
        typeRefs(type, ctx);
        for (const declarator of named(node).filter((child) => child.type === 'variable_declarator')) {
          const value = named(declarator).find((child) => child.id !== field(declarator, 'name')?.id) ?? null;
          local(
            ctx,
            field(declarator, 'name'),
            type?.type === 'implicit_type' ? inferred(value, ctx.scope) : declaredType(type, ctx.scope),
          );
          for (const child of named(declarator)) if (child.id !== field(declarator, 'name')?.id) visit(child, ctx);
        }
        return;
      }
      case 'declaration_pattern':
      case 'declaration_expression':
      case 'catch_declaration':
      case 'recursive_pattern': {
        const type = field(node, 'type');
        typeRefs(type, ctx);
        local(ctx, field(node, 'name'), type?.type === 'implicit_type' ? null : declaredType(type, ctx.scope));
        for (const child of named(node))
          if (child.id !== type?.id && child.id !== field(node, 'name')?.id) visit(child, ctx);
        return;
      }
      case 'constant_pattern':
      case 'type_pattern': {
        const name = nameSegments(named(node)[0] ?? null);
        if (name) relation(node, ctx, { rel: 'references', target: name, syntax: 'nameof' });
        else for (const child of named(node)) visit(child, ctx);
        return;
      }
      case 'member_access_expression': {
        // A non-invoked access such as `Color.Red` references its receiver only when it names a type.
        const name = nameSegments(field(node, 'expression'));
        if (name && /^[A-Z]/.test(name[0]!)) relation(node, ctx, { rel: 'references', target: name, syntax: 'nameof' });
        else visit(field(node, 'expression'), ctx);
        return;
      }
      case 'as_expression':
        visit(field(node, 'left'), ctx);
        typeRefs(field(node, 'right'), ctx);
        return;
      case 'is_expression':
        visit(field(node, 'left'), ctx);
        typeRefs(field(node, 'right'), ctx);
        return;
      case 'implicit_parameter':
        csharp.locals.push({ scope: ctx.scope, name: node.text, type: null });
        return;
    }
    let inner = ctx;
    if (BLOCK_SCOPES.has(node.type)) {
      inner = { ...ctx, scope: makeScope(ctx, 'block', node.type, ctx.type?.id ?? null, ctx.staticThis) };
      if (node.type === 'foreach_statement') {
        const type = field(node, 'type');
        typeRefs(type, inner);
        const left = field(node, 'left');
        if (left?.type === 'identifier')
          local(inner, left, type?.type === 'implicit_type' ? null : declaredType(type, inner.scope));
        else for (const name of left?.descendantsOfType('identifier') ?? []) local(inner, name, null);
        visit(field(node, 'right'), ctx);
        visit(field(node, 'body'), inner);
        return;
      }
      if (node.type === 'lambda_expression' || node.type === 'anonymous_method_expression') {
        const list = field(node, 'parameters');
        if (list?.type === 'implicit_parameter') local(inner, list, null);
        else addParameters(parameters(list), inner.scope, inner);
        typeRefs(field(node, 'type'), inner);
        visit(field(node, 'body'), inner);
        return;
      }
    }
    for (let index = 0; index < node.childCount; index++) {
      const child = node.child(index);
      if (!child?.isNamed) continue;
      const name = node.fieldNameForChild(index);
      if (name === 'type' || name === 'returns') typeRefs(child, inner);
      else if (child.type === 'type_argument_list') for (const argument of named(child)) typeRefs(argument, inner);
      else visit(child, inner);
    }
  };
  visit(tree.rootNode, {
    scope: 'file',
    owner: null,
    type: null,
    namespace: '',
    container: '',
    staticThis: false,
    publicOwner: true,
  });
  return record;
}
