'use strict';

const { Value, Call, Code, Assign, Return, Op, Parens, NumberLiteral, StringLiteral,
  BooleanLiteral, NullLiteral, UndefinedLiteral, Arr, Obj, Splat } = require('../coffeescript/nodes');

// Undefined means the compiler cannot prove whether the value matches.
function accepts(type, actual, resolveType) {
  if (!type || !actual) return undefined;
  type = type.trim();
  if (type === 'any' || type === 'unknown' || type === '*') return true;
  if (type.startsWith('(') && type.endsWith(')')) {
    const inner = type.slice(1, -1);
    if (splitUnion(inner).length > 1 || !/[()]/.test(inner)) return accepts(inner, actual, resolveType);
  }
  const alternatives = splitUnion(type);
  if (alternatives.length > 1) return anyMatch(alternatives.map(part => accepts(part, actual, resolveType)));
  if (type.endsWith('?')) return anyMatch(['null', 'undefined', type.slice(0, -1)].map(part => accepts(part, actual, resolveType)));
  if (type.endsWith('[]')) {
    if (actual.type !== 'array') return false;
    if (!actual.items) return undefined;
    const matches = actual.items.map(item => accepts(type.slice(0, -2), item, resolveType));
    return matches.includes(false) ? false : matches.every(result => result === true) ? true : undefined;
  }
  if (type === 'void') return actual.type === 'undefined';
  if (['number', 'string', 'boolean', 'bigint', 'symbol', 'function', 'null', 'undefined', 'array'].includes(type)) return actual.type === type;
  if (type === 'object') return ['object', 'array'].includes(actual.type);
  try {
    const literal = JSON.parse(type);
    if (['string', 'number', 'boolean'].includes(typeof literal)) {
      if (typeof literal !== actual.type) return false;
      return Object.hasOwn(actual, 'value') ? actual.value === literal : undefined;
    }
  } catch { /* Named contracts are interpreted by the host. */ }
  if (resolveType) return resolveType(type, actual.value);
}

function splitUnion(type) {
  const parts = [];
  let start = 0, depth = 0, quote = '';
  for (let i = 0; i < type.length; i++) {
    const char = type[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[' || char === '{' || char === '<') depth++;
    else if (char === ')' || char === ']' || char === '}' || char === '>') depth--;
    else if (char === '|' && depth === 0) {
      parts.push(type.slice(start, i));
      start = i + 1;
    }
  }
  return [...parts, type.slice(start)];
}

function anyMatch(results) {
  if (results.includes(true)) return true;
  if (results.every(result => result === false)) return false;
}

function valueType(value, seen = new Set()) {
  if (value === null) return { type: 'null', value };
  if (!Array.isArray(value)) return { type: typeof value, value };
  if (seen.has(value)) return { type: 'array', value };
  seen.add(value);
  const items = Array.from(value, item => valueType(item, seen));
  seen.delete(value);
  return { type: 'array', value, items };
}

function unwrap(node) {
  if (node instanceof Value && node.properties.length === 0) return unwrap(node.base);
  if (node instanceof Parens && node.body.expressions?.length === 1) return unwrap(node.body.expressions[0]);
  if (node instanceof Op && node.operator === 'await') return unwrap(node.first);
  return node;
}

function infer(node) {
  node = unwrap(node);
  if (node instanceof NumberLiteral) {
    if (node.value.endsWith('n')) return { type: 'bigint' };
    return valueType(node.parsedValue);
  }
  if (node instanceof StringLiteral && node.quote === '"') {
    try { return valueType(JSON.parse(node.value)); } catch { return { type: 'string' }; }
  }
  if (node instanceof StringLiteral) {
    return node.originalValue?.includes('\\') ? { type: 'string' } : valueType(node.originalValue);
  }
  if (node instanceof BooleanLiteral) return valueType(node.value === 'true');
  if (node instanceof NullLiteral) return valueType(null);
  if (node instanceof UndefinedLiteral) return valueType(undefined);
  if (node instanceof Code) return { type: 'function' };
  if (node instanceof Obj) return { type: 'object' };
  if (node instanceof Arr) {
    if (node.objects.some(item => item instanceof Splat)) return { type: 'array' };
    return { type: 'array', items: node.objects.map(infer) };
  }
  if (node instanceof Op && ['+', '-'].includes(node.operator) && !node.second) {
    const operand = infer(node.first);
    if (operand?.type === 'number') return valueType(node.operator === '-' ? -operand.value : operand.value);
  }
}

function inspectContracts(ast, declarations, calls) {
  const callNodes = new Map();
  const callsByLine = new Map(calls.map(call => [call.line, call]));
  ast.traverseChildren(true, node => {
    if (!(node instanceof Call) || unwrap(node.variable)?.value !== '$') return;
    const line = node.locationData.first_line + 1;
    const name = unwrap(node.args[0])?.value;
    const call = callsByLine.get(line);
    if (call && JSON.stringify(call.name) === name) callNodes.set(node, call);
  });
  const argumentsByCall = new Map();
  for (const [node, call] of callNodes) {
    const args = node.args.slice(1);
    if (!args.some(arg => arg instanceof Splat)) argumentsByCall.set(call, args.map(infer));
  }
  const signatures = new Map(declarations.map(declaration => [declaration.line, declaration]));
  const returns = [];
  for (const statement of ast.body.expressions) {
    if (!(statement instanceof Assign) || !(statement.value instanceof Code)) continue;
    const signature = signatures.get(statement.locationData.first_line + 1);
    if (!signature?.returns || signature.returns === 'void' || statement.value.isGenerator) continue;
    const body = statement.value.body;
    const expressions = body.expressions.filter(node => node.constructor.name !== 'Comment');
    const tail = expressions.at(-1);
    const candidates = tail && !(tail instanceof Return) ? [tail] : [];
    body.traverseChildren(false, node => {
      if (node instanceof Return) candidates.push(node);
    });
    for (const candidate of candidates) {
      const expression = candidate instanceof Return ? candidate.expression : candidate;
      returns.push({
        signature,
        line: candidate.locationData.first_line + 1,
        actual: expression ? infer(expression) : valueType(undefined),
        call: callNodes.get(unwrap(expression)),
      });
    }
  }
  return { argumentsByCall, returns };
}

function validateArguments(resource, args, report, resolveType) {
  if (resource.kind === 'module') return;
  if (args.length > resource.params.length) report('too many arguments');
  for (const [index, param] of resource.params.entries()) {
    const actual = args[index];
    if (param.default !== undefined && (index >= args.length || actual?.type === 'undefined')) continue;
    if (index >= args.length) report(`missing argument ${param.name}`);
    const match = accepts(param.resolvedType || param.type, actual, resolveType);
    if (match === false || (match === undefined && resolveType)) report(`argument ${param.name} expects ${param.type}`);
  }
}

module.exports = { accepts, inspectContracts, validateArguments, valueType, splitUnion };
