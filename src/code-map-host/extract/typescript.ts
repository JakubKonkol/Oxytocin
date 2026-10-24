import type { Node, Tree } from 'web-tree-sitter';
import type { CodeMapSymbol } from '@shared/domain/code-map';
import { CodeMapLimitError } from '../enumerate';
import { fileRecord } from './files';
import type { FileRecord, RelationIntent, Scope, TypeRef } from './record';

interface Context {
  scope: string;
  owner: string | null;
  classId: string | null;
  staticThis: boolean;
  exported: boolean;
  defaultExport: boolean;
  publicOwner: boolean;
}
const field = (node: Node, name: string) => node.childForFieldName(name);
const point = (node: Node): [number, number] => [node.startPosition.row + 1, node.startPosition.column];
function clean(node: Node | null): string {
  if (!node) return '';
  let text = node.text;
  for (const comment of node.descendantsOfType('comment').reverse())
    text = text.slice(0, comment.startIndex - node.startIndex) + ' ' + text.slice(comment.endIndex - node.startIndex);
  return text.replace(/\s+/g, ' ').trim().slice(0, 1000);
}
function literal(node: Node | null): string | null {
  return node?.type === 'string' ? node.text.slice(1, -1).replace(/\\(['"\\])/g, '$1') : null;
}
function target(node: Node | null): string[] | null {
  if (!node) return null;
  if (['identifier', 'type_identifier', 'property_identifier', 'this', 'super'].includes(node.type)) return [node.text];
  if (['member_expression', 'nested_type_identifier', 'nested_identifier'].includes(node.type)) {
    const object = field(node, 'object') ?? field(node, 'module') ?? node.namedChildren[0] ?? null;
    const property = field(node, 'property') ?? field(node, 'name') ?? node.namedChildren.at(-1) ?? null;
    const prefix = target(object);
    return prefix && property && property.id !== object?.id && !node.children.some((child) => child.type === '[')
      ? [...prefix, property.text]
      : null;
  }
  if (['generic_type', 'parenthesized_expression', 'type_annotation'].includes(node.type))
    return target(node.namedChildren[0] ?? null);
  return null;
}
function names(pattern: Node | null): string[] {
  if (!pattern) return [];
  if (['identifier', 'shorthand_property_identifier_pattern'].includes(pattern.type)) return [pattern.text];
  if (pattern.type === 'pair_pattern') return names(field(pattern, 'value'));
  if (pattern.type === 'assignment_pattern') return names(field(pattern, 'left'));
  return pattern.namedChildren.flatMap((child) =>
    ['type_annotation', 'comment'].includes(child.type) ? [] : names(child),
  );
}
/** Utility types whose members are some of the wrapped type's own members, unchanged. */
const MEMBER_PRESERVING = ['Pick', 'Omit', 'Readonly', 'Required', 'Partial', 'NonNullable'];
const significant = (node: Node) => node.namedChildren.filter((child) => child.type !== 'comment');
const isNullish = (node: Node) => node.type === 'literal_type' && ['null', 'undefined'].includes(node.text);
function unionMembers(node: Node): Node[] {
  if (node.type === 'union_type') return significant(node).flatMap(unionMembers);
  if (node.type === 'parenthesized_type') {
    const inner = significant(node)[0];
    return inner ? unionMembers(inner) : [];
  }
  return [node];
}
/**
 * The type a source annotation names, as syntax. Only a single named type is recorded: `T`, `ns.T`, `T<...>` (type
 * arguments are ignored), `Promise<T>` (flagged) and `T | null | undefined`. Everything else stays unrecorded so the
 * resolver can never pick a member of a type the value does not have. `shape` admits an anonymous object type.
 */
function typeRef(node: Node | null, shape = false): TypeRef | null {
  if (!node) return null;
  if (node.type === 'type_annotation') return typeRef(significant(node)[0] ?? null, shape);
  if (node.type === 'union_type' || node.type === 'parenthesized_type') {
    const members = unionMembers(node).filter((member) => !isNullish(member));
    return members.length === 1 && members[0]!.id !== node.id ? typeRef(members[0]!, shape) : null;
  }
  if (node.type === 'type_identifier' || node.type === 'nested_type_identifier') {
    const name = target(node);
    return name && !name.includes('this') ? { name } : null;
  }
  if (node.type === 'generic_type') {
    const name = target(field(node, 'name'));
    if (!name) return null;
    const wrapper = name.length === 1 ? name[0]! : '';
    if (wrapper !== 'Promise' && !MEMBER_PRESERVING.includes(wrapper)) return { name };
    const args = significant(field(node, 'type_arguments') ?? node);
    const inner = wrapper === 'Promise' ? (args.length === 1 ? typeRef(args[0]!) : null) : typeRef(args[0] ?? null);
    if (!inner || !('name' in inner) || inner.promise) return null;
    return wrapper === 'Promise'
      ? { name: inner.name, ...(inner.wrappers ? { wrappers: inner.wrappers } : {}), promise: true }
      : { name: inner.name, wrappers: [...new Set([wrapper, ...(inner.wrappers ?? [])])] };
  }
  return node.type === 'object_type' && shape ? { shape: true } : null;
}
/** The type of an initializer when it is evident from syntax: `new T()`, `f()`, `await f()`, `x as T`, `<T>x`, `a.b`. */
function initializerType(value: Node | null): TypeRef | null {
  let node = value;
  let awaited = false;
  while (node && ['parenthesized_expression', 'non_null_expression', 'await_expression'].includes(node.type)) {
    if (node.type === 'await_expression') {
      if (awaited) return null;
      awaited = true;
    }
    node = significant(node)[0] ?? null;
  }
  if (!node) return null;
  const unwrapped = (ref: TypeRef | null): TypeRef | null =>
    ref && 'name' in ref
      ? {
          name: ref.name,
          ...(ref.wrappers ? { wrappers: ref.wrappers } : {}),
          ...(ref.promise && !awaited ? { promise: true as const } : {}),
        }
      : null;
  if (node.type === 'new_expression') {
    const name = awaited ? null : target(field(node, 'constructor'));
    return name && !['this', 'super'].includes(name[0]!) ? { name } : null;
  }
  if (node.type === 'call_expression') {
    const name = target(field(node, 'function'));
    return name && !['require', 'import', 'super'].includes(name[0]!)
      ? { call: name, ...(awaited ? { await: true as const } : {}) }
      : null;
  }
  if (node.type === 'identifier' || node.type === 'member_expression') {
    const path = awaited ? null : target(node);
    return path && path[0] !== 'super' ? { value: path } : null;
  }
  if (node.type === 'as_expression') {
    const parts = significant(node);
    return parts.length === 2 ? unwrapped(typeRef(parts[1]!)) : null;
  }
  if (node.type === 'type_assertion') {
    const parts = significant(node);
    return unwrapped(typeRef(significant(parts[0] ?? node)[0] ?? null));
  }
  return null;
}
function returnsJsx(node: Node): boolean {
  const visit = (current: Node): boolean => {
    if (
      current !== node &&
      ['function_declaration', 'function_expression', 'arrow_function', 'method_definition'].includes(current.type)
    )
      return false;
    if (['jsx_element', 'jsx_self_closing_element'].includes(current.type)) return true;
    return current.namedChildren.some(visit);
  };
  const body = field(node, 'body');
  if (!body) return false;
  const findReturn = (current: Node): boolean => {
    if (['function_declaration', 'function_expression', 'arrow_function', 'method_definition'].includes(current.type))
      return false;
    return current.type === 'return_statement' ? visit(current) : current.namedChildren.some(findReturn);
  };
  return body.type !== 'statement_block' ? visit(body) : findReturn(body);
}

/** Syntax-only extraction: no project execution, typechecker or name-based guesses across files. */
export function extractTypeScript(path: string, source: string, tree: Tree): FileRecord {
  const record = fileRecord(path, source);
  record.syntaxErrors = Math.max(tree.rootNode.descendantsOfType('ERROR').length, tree.rootNode.hasError ? 1 : 0);
  record.file.status = tree.rootNode.hasError ? 'syntax-errors' : 'ok';
  const scopeById = new Map(record.scopes.map((scope) => [scope.id, scope]));
  const occurrences = new Map<string, number>();
  const scopeCounts = new Map<string, number>();
  const symbolById = new Map<string, CodeMapSymbol>();
  const forcedClassNames = new Map<number, string>();
  const symbolBase = new Map<string, string>();
  // Plain JavaScript has no declarations: a mutable binding can later hold anything, only `const` is evident.
  const javascript = /\.[cm]?jsx?$/.test(path);
  const inferred = (value: Node | null, constant: boolean): TypeRef | null =>
    javascript && !constant ? null : initializerType(value);
  record.symbolTypes = [];
  const declareType = (symbol: CodeMapSymbol, scope: string, type: TypeRef | null) => {
    if (type) record.symbolTypes!.push({ symbol: symbol.id, scope, type });
  };
  const makeScope = (
    context: Context,
    kind: Scope['kind'],
    label: string,
    thisClass = context.classId,
    staticThis = context.staticThis,
  ): string => {
    const base = `${context.scope}/${kind}:${label}`;
    const count = (scopeCounts.get(base) ?? 0) + 1;
    scopeCounts.set(base, count);
    const id = `${base}~${count}`;
    const scope = { id, parent: context.scope, kind, thisClass, staticThis };
    record.scopes.push(scope);
    scopeById.set(id, scope);
    return id;
  };
  const bind = (
    name: string,
    context: Context,
    symbol: string | null,
    extra: Partial<FileRecord['bindings'][number]> = {},
  ) => record.bindings.push({ name, scope: context.scope, symbol, ...extra });
  const emit = (
    node: Node,
    name: string,
    kind: CodeMapSymbol['kind'],
    signature: string,
    context: Context,
  ): CodeMapSymbol => {
    const ownerName = context.owner ? (symbolById.get(context.owner)?.id.slice(`s:${path}#`.length) ?? '') : '';
    const base = `s:${path}#${ownerName ? `${ownerName}.` : ''}${kind}:${name}`;
    if (base.length > 8192)
      throw new CodeMapLimitError('Code Map symbol name or nesting limit reached — add exclusions');
    const count = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, count);
    const symbol: CodeMapSymbol = {
      id: count === 1 ? base : `${base}~${count}`,
      file: record.file.id,
      kind,
      name: name.slice(0, 1024),
      owner: context.owner,
      exported: context.exported && context.publicOwner,
      signature: signature.slice(0, 4000),
      span: [...point(node), node.endPosition.row + 1, node.endPosition.column],
    };
    if (record.symbols.length >= 50_000)
      throw new CodeMapLimitError('Code Map per-file symbol limit reached — add exclusions');
    record.symbols.push(symbol);
    symbolById.set(symbol.id, symbol);
    symbolBase.set(symbol.id, base);
    if (context.exported && context.scope === 'file')
      record.exports.push({
        name: context.defaultExport ? 'default' : name,
        symbol: symbol.id,
        typeOnly: ['interface', 'type'].includes(kind),
      });
    if (context.exported && scopeById.get(context.scope)?.kind === 'namespace' && context.owner)
      record.members.push({ owner: context.owner, name, symbol: symbol.id, static: true });
    return symbol;
  };
  const relation = (
    node: Node,
    context: Context,
    rel: RelationIntent['rel'],
    syntax: RelationIntent['syntax'],
    expression: Node | null,
  ) => {
    if (record.relations.length >= 100_000)
      throw new CodeMapLimitError('Code Map per-file relation limit reached — add exclusions');
    record.relations.push({
      from: context.owner ?? record.file.id,
      scope: context.scope,
      target: target(expression),
      rel,
      syntax,
      at: point(node),
    });
  };
  const parameters = (node: Node): string => {
    const list = field(node, 'parameters');
    const single = field(node, 'parameter');
    if (!list) return clean(single);
    return list.namedChildren
      .filter((child) => child.type !== 'comment')
      .map((parameter) => {
        const pattern = field(parameter, 'pattern') ?? field(parameter, 'name') ?? parameter;
        const label = ['object_pattern', 'array_pattern'].includes(pattern.type)
          ? `{${names(pattern).join(', ')}}`
          : clean(pattern);
        return `${label}${parameter.type === 'optional_parameter' ? '?' : ''}${clean(field(parameter, 'type'))}`;
      })
      .join(', ');
  };
  /** `p: T`, `p?: T`, and `p: T = new T()` when evident; destructured and rest parameters carry no type. */
  const parameterType = (parameter: Node): TypeRef | null => {
    if (!['required_parameter', 'optional_parameter'].includes(parameter.type)) return null;
    return typeRef(field(parameter, 'type')) ?? inferred(field(parameter, 'value'), false);
  };
  const addParameters = (node: Node, context: Context) => {
    for (const parameter of (field(node, 'parameters')?.namedChildren ?? [field(node, 'parameter')]).filter(
      (value): value is Node => !!value,
    )) {
      const pattern = field(parameter, 'pattern') ?? field(parameter, 'name') ?? parameter;
      const type = parameterType(parameter);
      for (const name of names(pattern))
        bind(name, context, null, type && pattern.type === 'identifier' ? { type } : {});
    }
    for (const parameter of field(node, 'type_parameters')?.namedChildren ?? []) {
      const name = field(parameter, 'name');
      if (name) bind(name.text, context, null);
    }
  };
  const propertyParameters = new Map<number, string>();
  /** `constructor(private readonly dep: Dep)` declares an instance property `dep` of the class. */
  const parameterProperties = (constructor: Node, context: Context): void => {
    for (const parameter of field(constructor, 'parameters')?.namedChildren ?? []) {
      if (!['required_parameter', 'optional_parameter'].includes(parameter.type)) continue;
      const modifiers = parameter.children.filter((child) =>
        ['accessibility_modifier', 'readonly', 'override_modifier'].includes(child.type),
      );
      const pattern = field(parameter, 'pattern');
      if (!modifiers.length || pattern?.type !== 'identifier') continue;
      const visible = !modifiers.some((part) => ['private', 'protected'].includes(part.text));
      const symbol = emit(
        parameter,
        pattern.text,
        'property',
        `${modifiers.map(clean).join(' ')} ${pattern.text}${clean(field(parameter, 'type'))}`,
        { ...context, exported: visible },
      );
      record.members.push({ owner: context.owner!, name: pattern.text, symbol: symbol.id, static: false });
      const type = typeRef(field(parameter, 'type'), true) ?? parameterType(parameter);
      declareType(symbol, context.scope, type);
      // `deps: { service: Service }`: the members of the anonymous object type belong to the property.
      if (type && 'shape' in type) propertyParameters.set(parameter.id, symbol.id);
    }
  };
  const visitFunction = (
    node: Node,
    context: Context,
    forcedName?: string,
    member = false,
    declaration = node,
  ): void => {
    const ownName = field(node, 'name')?.text;
    const name = forcedName ?? ownName ?? (context.defaultExport ? 'default' : null);
    const isArrow = node.type === 'arrow_function';
    let owner = context.owner;
    let declared: CodeMapSymbol | null = null;
    if (name) {
      const kind = member ? 'method' : returnsJsx(node) ? 'component' : 'function';
      const modifiers = node.children
        .filter((child) => ['accessibility_modifier', 'static', 'async', 'get', 'set', 'abstract'].includes(child.type))
        .map(clean)
        .join(' ');
      const signature = `${modifiers ? `${modifiers} ` : ''}${member ? '' : 'function '}${name}${clean(field(node, 'type_parameters'))}(${parameters(node)})${clean(field(node, 'return_type'))}`;
      const symbol = emit(declaration, name, kind, signature, context);
      owner = symbol.id;
      declared = symbol;
      if (member && context.owner)
        record.members.push({
          owner: context.owner,
          name,
          symbol: symbol.id,
          static: node.children.some((child) => child.type === 'static'),
          implementation: !!field(node, 'body'),
        });
      else if (forcedName || /declaration|signature/.test(node.type))
        bind(name, context, symbol.id, { implementation: !!field(node, 'body') });
    }
    // `this` in an object-literal method is the literal, not the enclosing class.
    const thisClass = member
      ? node.parent?.type === 'object'
        ? null
        : context.classId
      : isArrow
        ? context.classId
        : null;
    const staticThis = member ? node.children.some((child) => child.type === 'static') : context.staticThis;
    const next = {
      ...context,
      owner,
      classId: thisClass,
      staticThis,
      scope: makeScope(context, 'function', name ?? 'anonymous', thisClass, staticThis),
      exported: false,
      defaultExport: false,
      publicOwner: false,
    };
    if (ownName && name && ownName !== name) bind(ownName, next, owner);
    if (ownName && !forcedName && !/declaration|signature/.test(node.type)) bind(ownName, next, owner);
    addParameters(node, next);
    if (declared) declareType(declared, next.scope, typeRef(field(node, 'return_type')));
    if (member && ownName === 'constructor' && context.owner && context.classId) parameterProperties(node, context);
    for (const child of node.namedChildren) if (child.id !== field(node, 'name')?.id) visit(child, next);
  };
  const visitImport = (node: Node, context: Context): void => {
    const module = literal(field(node, 'source')) ?? literal(node.descendantsOfType('string')[0] ?? null);
    if (module === null) return;
    const typeOnly = node.children.some((child) => child.type === 'type');
    record.imports.push({ module, scope: context.scope, at: point(node), typeOnly, kind: 'import' });
    const clause = node.namedChildren.find((child) => ['import_clause', 'import_require_clause'].includes(child.type));
    for (const child of clause?.namedChildren ?? []) {
      if (child.type === 'identifier')
        bind(child.text, context, null, {
          imported: { module, name: clause?.type === 'import_require_clause' ? '*' : 'default', typeOnly },
        });
      if (child.type === 'namespace_import') {
        const name = child.namedChildren.at(-1);
        if (name) bind(name.text, context, null, { imported: { module, name: '*', typeOnly } });
      }
      if (child.type === 'named_imports')
        for (const specifier of child.namedChildren) {
          if (specifier.type !== 'import_specifier') continue;
          const name = field(specifier, 'name'),
            alias = field(specifier, 'alias') ?? name;
          if (name && alias)
            bind(alias.text, context, null, {
              imported: {
                module,
                name: name.text,
                typeOnly: typeOnly || specifier.children.some((part) => part.type === 'type'),
              },
            });
        }
    }
  };
  const visitExport = (node: Node, context: Context): void => {
    const typeOnly = node.children.some((child) => child.type === 'type');
    const module = literal(field(node, 'source'));
    if (module !== null)
      record.imports.push({ module, scope: context.scope, at: point(node), typeOnly, kind: 'export' });
    const clause = node.namedChildren.find((child) => child.type === 'export_clause');
    for (const specifier of clause?.namedChildren ?? []) {
      const local = field(specifier, 'name'),
        exported = field(specifier, 'alias') ?? local;
      if (local && exported)
        record.exports.push({
          name: exported.text,
          ...(module !== null ? { module, imported: local.text } : { local: local.text }),
          typeOnly: typeOnly || specifier.children.some((part) => part.type === 'type'),
        });
    }
    const namespace = node.namedChildren.find((child) => child.type === 'namespace_export');
    if (module !== null && !clause)
      record.exports.push({ name: namespace?.namedChildren.at(-1)?.text ?? '*', module, imported: '*', typeOnly });
    const declaration = field(node, 'declaration');
    const isDefault = node.children.some((child) => child.type === 'default');
    if (declaration) visit(declaration, { ...context, exported: true, defaultExport: isDefault });
    else if (isDefault) {
      const value =
        field(node, 'value') ??
        node.namedChildren.find((child) => !['comment', 'export_clause'].includes(child.type)) ??
        null;
      if (value?.type === 'identifier') record.exports.push({ name: 'default', local: value.text, typeOnly: false });
      else if (value && ['class', 'class_declaration'].includes(value.type))
        visit(value, { ...context, exported: true, defaultExport: true });
      else if (value && ['arrow_function', 'function_expression', 'generator_function'].includes(value.type))
        visitFunction(value, { ...context, exported: true, defaultExport: true });
    }
  };
  const visit = (node: Node, context: Context): void => {
    if (node.type === 'comment') return;
    const propertyId = propertyParameters.get(node.id);
    if (propertyId) {
      const annotation = field(node, 'type');
      for (const child of node.namedChildren)
        visit(child, child.id === annotation?.id ? { ...context, owner: propertyId, exported: false } : context);
      return;
    }
    if (node.type === 'import_statement') {
      visitImport(node, context);
      return;
    }
    if (node.type === 'export_statement') {
      visitExport(node, context);
      return;
    }
    if (
      [
        'function_declaration',
        'generator_function_declaration',
        'function_expression',
        'generator_function',
        'arrow_function',
        'function_signature',
      ].includes(node.type)
    ) {
      visitFunction(node, context);
      return;
    }
    if (['method_definition', 'method_signature', 'abstract_method_signature'].includes(node.type)) {
      visitFunction(
        node,
        {
          ...context,
          exported:
            node.parent?.type !== 'object' &&
            !field(node, 'name')?.text.startsWith('#') &&
            !node.namedChildren.some(
              (part) => part.type === 'accessibility_modifier' && ['private', 'protected'].includes(part.text),
            ),
        },
        undefined,
        true,
      );
      return;
    }
    if (
      [
        'class_declaration',
        'abstract_class_declaration',
        'class',
        'interface_declaration',
        'type_alias_declaration',
        'enum_declaration',
        'internal_module',
      ].includes(node.type)
    ) {
      const name =
        forcedClassNames.get(node.id) ??
        field(node, 'name')?.text ??
        (context.defaultExport ? 'default' : '<anonymous>');
      const kind =
        node.type === 'interface_declaration'
          ? 'interface'
          : node.type === 'type_alias_declaration'
            ? 'type'
            : node.type === 'enum_declaration'
              ? 'enum'
              : node.type === 'internal_module'
                ? 'namespace'
                : 'class';
      const symbol = emit(
        node,
        name,
        kind,
        `${kind} ${name}${clean(field(node, 'type_parameters'))}${kind === 'type' ? ` = ${clean(field(node, 'value'))}` : ''}`,
        context,
      );
      bind(name, context, symbol.id);
      const scopeKind = kind === 'namespace' ? 'namespace' : 'class';
      const next = {
        ...context,
        owner: symbol.id,
        scope: makeScope(context, scopeKind, name, symbol.id),
        classId: symbol.id,
        exported: false,
        defaultExport: false,
        publicOwner: symbol.exported,
      };
      const innerName = field(node, 'name')?.text;
      if (innerName && innerName !== name) bind(innerName, next, symbol.id);
      for (const parameter of field(node, 'type_parameters')?.namedChildren ?? []) {
        const identifier = field(parameter, 'name');
        if (identifier) bind(identifier.text, next, null);
      }
      if (kind === 'type') declareType(symbol, next.scope, typeRef(field(node, 'value'), true));
      for (const child of node.namedChildren)
        if (child.id !== field(node, 'name')?.id && child.id !== field(node, 'type_parameters')?.id) visit(child, next);
      return;
    }
    if (node.type === 'variable_declarator') {
      const pattern = field(node, 'name'),
        value = field(node, 'value');
      const declared = names(pattern);
      let bindingContext = context;
      if (node.parent?.type === 'variable_declaration') {
        let scope = scopeById.get(context.scope);
        while (scope?.parent && !['file', 'function', 'namespace'].includes(scope.kind))
          scope = scopeById.get(scope.parent);
        if (scope) bindingContext = { ...context, scope: scope.id };
      }
      if (
        declared.length === 1 &&
        value &&
        ['arrow_function', 'function_expression', 'generator_function'].includes(value.type)
      ) {
        visitFunction(value, bindingContext, declared[0], false, node);
        return;
      }
      if (declared.length === 1 && value?.type === 'class') {
        forcedClassNames.set(value.id, declared[0]!);
        visit(value, bindingContext);
        return;
      }
      let imported: FileRecord['bindings'][number]['imported'];
      let initializer = value;
      if (initializer?.type === 'await_expression') initializer = initializer.namedChildren[0] ?? null;
      if (initializer?.type === 'call_expression') {
        const fn = field(initializer, 'function')?.text,
          module = literal(field(initializer, 'arguments')?.namedChildren[0] ?? null);
        if (module !== null && (fn === 'require' || (fn === 'import' && value?.type === 'await_expression')))
          imported = { module, name: '*', typeOnly: false, ...(fn === 'require' ? { require: true } : {}) };
      }
      const declaredType =
        pattern?.type === 'identifier'
          ? (typeRef(field(node, 'type')) ?? inferred(value, node.parent?.children[0]?.type === 'const'))
          : null;
      // `const { service, logger: log } = this.deps` takes the member types of an evident source path.
      const destructured = new Map<string, TypeRef>();
      let source = value;
      while (source && ['parenthesized_expression', 'non_null_expression'].includes(source.type))
        source = significant(source)[0] ?? null;
      const sourcePath =
        pattern?.type === 'object_pattern' &&
        !field(node, 'type') &&
        ['identifier', 'member_expression'].includes(source?.type ?? '')
          ? target(source)
          : null;
      if (
        sourcePath &&
        sourcePath.length < 18 &&
        sourcePath[0] !== 'super' &&
        (!javascript || node.parent?.children[0]?.type === 'const')
      )
        for (const child of significant(pattern!)) {
          const key = field(child, 'key');
          const local = field(child, 'value');
          if (child.type === 'shorthand_property_identifier_pattern')
            destructured.set(child.text, { value: [...sourcePath, child.text] });
          else if (child.type === 'pair_pattern' && key?.type === 'property_identifier' && local?.type === 'identifier')
            destructured.set(local.text, { value: [...sourcePath, key.text] });
        }
      for (const name of declared) {
        const symbol = context.exported
          ? emit(node, name, 'variable', `const ${name}${clean(field(node, 'type'))}`, context)
          : null;
        const type = declaredType ?? destructured.get(name) ?? null;
        if (symbol) declareType(symbol, bindingContext.scope, type);
        let bindingImport = imported;
        if (bindingImport && pattern?.type === 'object_pattern') {
          const pair = pattern.namedChildren.find((child) => names(child).includes(name));
          bindingImport = {
            ...bindingImport,
            name: pair?.type === 'pair_pattern' ? (field(pair, 'key')?.text ?? name) : name,
          };
        }
        bind(name, bindingContext, symbol?.id ?? null, {
          ...(bindingImport ? { imported: bindingImport } : {}),
          ...(type ? { type } : {}),
        });
      }
      const annotation = field(node, 'type');
      if (annotation) visit(annotation, { ...context, exported: false });
      if (value) visit(value, { ...context, exported: false, defaultExport: false });
      return;
    }
    if (['public_field_definition', 'property_signature'].includes(node.type)) {
      const name = field(node, 'name')?.text;
      if (name) {
        const visible =
          !name.startsWith('#') &&
          !node.namedChildren.some(
            (part) => part.type === 'accessibility_modifier' && ['private', 'protected'].includes(part.text),
          );
        const modifiers = node.children
          .filter((child) =>
            ['accessibility_modifier', 'static', 'readonly', 'abstract', 'override_modifier'].includes(child.type),
          )
          .map(clean)
          .join(' ');
        const symbol = emit(
          node,
          name,
          'property',
          `${modifiers ? `${modifiers} ` : ''}${name}${clean(field(node, 'type'))}`,
          {
            ...context,
            exported: visible,
          },
        );
        if (context.owner)
          record.members.push({
            owner: context.owner,
            name,
            symbol: symbol.id,
            static: node.children.some((child) => child.type === 'static'),
          });
        const value = field(node, 'value');
        const annotation = field(node, 'type');
        declareType(symbol, context.scope, typeRef(annotation, true) ?? inferred(value, false));
        if (annotation) visit(annotation, { ...context, owner: symbol.id, exported: false });
        if (value) visit(value, { ...context, owner: symbol.id, exported: false, publicOwner: false });
      }
      return;
    }
    if (node.type === 'extends_clause' || node.type === 'implements_clause' || node.type === 'extends_type_clause') {
      const values = field(node, 'value') ? [field(node, 'value')!] : node.namedChildren;
      for (const value of values)
        relation(value, context, node.type === 'implements_clause' ? 'implements' : 'extends', 'type', value);
      return;
    }
    if (node.type === 'call_expression' || node.type === 'new_expression') {
      const expression = field(node, node.type === 'new_expression' ? 'constructor' : 'function');
      if (expression?.text === 'import' || expression?.text === 'require')
        record.imports.push({
          module: literal(field(node, 'arguments')?.namedChildren[0] ?? null),
          scope: context.scope,
          at: point(node),
          typeOnly: false,
          kind: expression.text === 'import' ? 'dynamic' : 'require',
        });
      if (expression?.text !== 'import')
        relation(node, context, 'calls', node.type === 'new_expression' ? 'new' : 'call', expression);
    }
    if (['jsx_opening_element', 'jsx_self_closing_element'].includes(node.type)) {
      const name = field(node, 'name');
      if (name && (/^[A-Z]/.test(name.text) || name.type === 'member_expression'))
        relation(node, context, 'calls', 'jsx', name);
    }
    if (node.type === 'type_identifier' && node.parent?.type !== 'type_parameter')
      relation(node, context, 'references', 'type', node);
    if (['identifier', 'member_expression'].includes(node.type) && node.parent?.type === 'arguments')
      relation(node, context, 'references', 'value', node);
    if (
      ['statement_block', 'for_statement', 'for_in_statement', 'catch_clause', 'switch_body'].includes(node.type) &&
      node.parent?.type !== 'internal_module'
    )
      context = { ...context, scope: makeScope(context, 'block', node.type), exported: false, defaultExport: false };
    if (node.type === 'catch_clause') for (const name of names(field(node, 'parameter'))) bind(name, context, null);
    if (node.type === 'for_in_statement' && field(node, 'kind'))
      for (const name of names(field(node, 'left'))) bind(name, context, null);
    for (const child of node.namedChildren) visit(child, context);
  };
  visit(tree.rootNode, {
    scope: 'file',
    owner: null,
    classId: null,
    staticThis: false,
    exported: false,
    defaultExport: false,
    publicOwner: true,
  });
  // Overloaded or merged declarations share one symbol base: no single signature speaks for them.
  record.symbolTypes = record.symbolTypes.filter(
    (entry) => (occurrences.get(symbolBase.get(entry.symbol) ?? '') ?? 1) === 1,
  );
  return record;
}
