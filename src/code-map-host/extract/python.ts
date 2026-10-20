import { posix } from 'node:path';
import type { Node, Tree } from 'web-tree-sitter';
import { CodeMapLimitError } from '../enumerate';
import type { FileRecord, PythonRecord } from './record';
import { field, named, point, syntaxRecord } from './syntax';

function target(node: Node | null): string[] | null {
  if (!node) return null;
  if (node.type === 'identifier' || node.type === 'dotted_name') return node.text.split('.').slice(0, 20);
  if (node.type === 'attribute') {
    const left = target(field(node, 'object')),
      right = field(node, 'attribute');
    return left && right ? [...left, right.text].slice(0, 20) : null;
  }
  return null;
}
function string(node: Node): string | null {
  return node.type === 'string' && /^(['"])[^\\\r\n]*\1$/.test(node.text) ? node.text.slice(1, -1) : null;
}
function boundNames(node: Node | null): Node[] {
  if (!node) return [];
  if (node.type === 'identifier') return [node];
  return ['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list', 'list_splat_pattern'].includes(node.type)
    ? named(node).flatMap(boundNames)
    : [];
}

/** Python lexical declarations/imports only. No execution, annotations-based inference or instance guessing. */
export function extractPython(path: string, source: string, tree: Tree): FileRecord {
  const { record, scope, emit } = syntaxRecord(path, source, tree);
  record.file.test ||= /(^|\/)test_[^/]*\.py$|_test\.py$/.test(path);
  const module = emit(
    tree.rootNode,
    posix.basename(path, '.py'),
    'namespace',
    null,
    true,
    `module ${posix.basename(path, '.py')}`,
  );
  const python: PythonRecord = { module: module.id, imports: [], definitions: [], bindings: [], bases: [], calls: [] };
  record.python = python;
  type Context = { scope: string; owner: string; ownerClass: string | null; classBody: boolean; decorators: string[] };
  const binding = (entry: PythonRecord['bindings'][number]) => {
    if (python.bindings.length >= 100_000) throw new CodeMapLimitError();
    python.bindings.push(entry);
  };
  const walk = (node: Node, ctx: Context) => {
    if (node.type === 'decorated_definition') {
      const definition = field(node, 'definition');
      if (definition)
        walk(definition, {
          ...ctx,
          decorators: named(node)
            .filter((n) => n.type === 'decorator')
            .map((n) => {
              const expression = named(n)[0];
              const parts = target(expression?.type === 'call' ? field(expression, 'function') : (expression ?? null));
              return parts
                ? `@${parts.join('.')}${expression?.type === 'call' ? '(...)' : ''}`.slice(0, 1000)
                : '@<expression>';
            })
            .slice(0, 100),
        });
      return;
    }
    if (node.type === 'function_definition' || node.type === 'class_definition') {
      const name = field(node, 'name')?.text;
      if (!name) return;
      const isClass = node.type === 'class_definition',
        symbol = emit(
          node,
          name,
          isClass ? 'class' : ctx.classBody ? 'method' : 'function',
          ctx.owner,
          !name.startsWith('_'),
        );
      if (ctx.decorators.length) symbol.decorators = ctx.decorators;
      python.definitions.push({
        symbol: symbol.id,
        name,
        scope: ctx.scope,
        kind: isClass ? 'class' : 'function',
        ownerClass: ctx.classBody ? ctx.ownerClass : null,
      });
      binding({ scope: ctx.scope, name, kind: 'definition', symbol: symbol.id });
      const next: Context = {
        scope: scope(ctx.scope, isClass ? 'class' : 'function', isClass ? symbol.id : ctx.ownerClass),
        owner: symbol.id,
        ownerClass: isClass ? symbol.id : ctx.ownerClass,
        classBody: isClass,
        decorators: [],
      };
      if (isClass)
        for (const base of named(field(node, 'superclasses')))
          if (base.type !== 'keyword_argument')
            python.bases.push({ symbol: symbol.id, scope: ctx.scope, target: target(base), at: point(base) });
      if (!isClass) {
        const parameters = named(field(node, 'parameters'));
        for (const [index, p] of parameters.entries()) {
          const nameNode =
            field(p, 'name') ?? (p.type === 'identifier' ? p : named(p).find((n) => n.type === 'identifier'));
          if (nameNode)
            binding({
              scope: next.scope,
              name: nameNode.text,
              kind: ctx.classBody && index === 0 && ['self', 'cls'].includes(nameNode.text) ? 'self' : 'unknown',
              ...(ctx.classBody && ctx.ownerClass ? { symbol: ctx.ownerClass } : {}),
            });
          const value = field(p, 'value');
          if (value) walk(value, ctx);
        }
      }
      const body = field(node, 'body');
      if (body) walk(body, next);
      return;
    }
    if (node.type === 'import_statement' || node.type === 'import_from_statement') {
      const from = node.type === 'import_from_statement',
        moduleName = field(node, 'module_name')?.text ?? '';
      const level = /^\.+/.exec(moduleName)?.[0].length ?? 0,
        moduleNameWithoutDots = moduleName.slice(level);
      const names = node.childrenForFieldName('name').map((n) => {
        const name = field(n, 'name')?.text ?? n.text,
          alias = field(n, 'alias')?.text ?? (from ? name : name.split('.')[0]!);
        return { name, alias, explicitAlias: !!field(n, 'alias') };
      });
      const wildcard = named(node).some((n) => n.type === 'wildcard_import');
      if (from)
        python.imports.push({
          module: moduleNameWithoutDots,
          level,
          scope: ctx.scope,
          names: names.map(({ name, alias }) => ({ name, alias })),
          from: true,
          wildcard,
          at: point(node),
        });
      else
        for (const item of names)
          python.imports.push({
            module: item.name,
            level: 0,
            scope: ctx.scope,
            names: [{ name: item.name, alias: item.alias }],
            from: false,
            wildcard: false,
            at: point(node),
          });
      for (const item of names)
        binding({
          scope: ctx.scope,
          name: item.alias,
          kind: 'import',
          module: from ? moduleNameWithoutDots : item.explicitAlias ? item.name : item.name.split('.')[0]!,
          imported: from ? item.name : null,
          level,
        });
      return;
    }
    if (['assignment', 'augmented_assignment', 'named_expression'].includes(node.type)) {
      const left = field(node, 'left') ?? field(node, 'name'),
        right = field(node, 'right') ?? field(node, 'value');
      const names = boundNames(left);
      for (const name of names) {
        if (ctx.scope === 'file' && name.text === '__all__') {
          const values = named(right).map(string);
          python.all =
            node.type === 'assignment' &&
            right &&
            ['list', 'tuple'].includes(right.type) &&
            values.every((v) => v !== null)
              ? values
              : null;
        }
        if (ctx.scope === 'file' || ctx.classBody) {
          const symbol = emit(
            name,
            name.text,
            ctx.classBody ? 'property' : 'variable',
            ctx.owner,
            !name.text.startsWith('_'),
            name.text,
          );
          python.definitions.push({
            symbol: symbol.id,
            name: name.text,
            scope: ctx.scope,
            kind: 'variable',
            ownerClass: ctx.classBody ? ctx.ownerClass : null,
          });
          binding({ scope: ctx.scope, name: name.text, kind: 'definition', symbol: symbol.id });
        } else binding({ scope: ctx.scope, name: name.text, kind: 'unknown' });
      }
      if (right) walk(right, ctx);
      return;
    }
    if (
      ['list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression'].includes(
        node.type,
      )
    ) {
      const next = { ...ctx, scope: scope(ctx.scope, 'function', null), classBody: false };
      for (const clause of named(node).filter((n) => n.type === 'for_in_clause'))
        for (const name of boundNames(field(clause, 'left')))
          binding({ scope: next.scope, name: name.text, kind: 'unknown' });
      for (const child of named(node)) walk(child, next);
      return;
    }
    if (['for_statement', 'for_in_clause', 'with_item', 'except_clause'].includes(node.type)) {
      const left = field(node, 'left') ?? field(node, 'alias') ?? field(node, 'name');
      for (const name of boundNames(left)) binding({ scope: ctx.scope, name: name.text, kind: 'unknown' });
    }
    if (node.type === 'lambda') {
      const next = { ...ctx, scope: scope(ctx.scope, 'function', null), classBody: false };
      for (const p of named(field(node, 'parameters')))
        binding({ scope: next.scope, name: field(p, 'name')?.text ?? p.text, kind: 'unknown' });
      const body = field(node, 'body');
      if (body) walk(body, next);
      return;
    }
    if (node.type === 'call') {
      if (python.calls.length >= 100_000) throw new CodeMapLimitError();
      python.calls.push({
        from: ctx.owner,
        scope: ctx.scope,
        ownerClass: ctx.ownerClass,
        target: target(field(node, 'function')),
        at: point(node),
      });
    }
    for (const child of named(node)) walk(child, ctx);
  };
  walk(tree.rootNode, { scope: 'file', owner: module.id, ownerClass: null, classBody: false, decorators: [] });
  if (python.all !== undefined)
    for (const definition of python.definitions.filter((d) => d.scope === 'file'))
      record.symbols.find((s) => s.id === definition.symbol)!.exported = python.all?.includes(definition.name) ?? false;
  return record;
}
