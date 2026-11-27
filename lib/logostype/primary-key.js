'use strict';

const { infer, unwrap } = require('./contracts');
const { Assign, IdentifierLiteral, Index, Obj, Value } = require('../coffeescript/nodes');

function lowerPrimaryKeyReads(coffee, source, options) {
  const models = new Map((options.primaryKeyModels || []).filter(model => model.primaryKey).map(model => [model.name, model]));
  if (!models.size) return { source, reads: [] };

  // CoffeeScript determines function scope while generating code. Inspect the
  // completed scopes so that a later declaration also shadows an ambient model.
  const candidates = new Map();
  coffee.compile(source, {
    filename: options.filename,
    bare: true,
    inspectAwait(operand, scope) {
      const value = operand.unwrapAll();
      if (!(value instanceof Value) || !(value.base instanceof IdentifierLiteral)) return;
      const [index] = value.properties;
      if (value.properties.length !== 1 || !(index instanceof Index) || index.soak) return;
      const model = models.get(value.base.value);
      if (!model) return;
      const [start, end] = value.locationData.range;
      const [open, close] = index.locationData.range;
      candidates.set(start, { model, scope, start, end, open, close, key: index.index });
    }
  });

  const edits = [], reads = [];
  for (const { model, scope, start, end, open, close, key } of candidates.values()) {
    if (scope.check(model.name)) continue;
    validateLiteral(model, key, options.filename);
    // The host binds this method on the ambient model. The model
    // operand remains an ordinary CoffeeScript identifier in the generated code.
    edits.push([start, open + 1, model.name + '.__logosReadPrimaryKey('], [close - 1, end, ')']);
    reads.push({ model: model.name, returns: model.name + ' | null' });
  }
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) {
    source = source.slice(0, start) + replacement + source.slice(end);
  }
  return { source, reads };
}

function validateLiteral(model, key, filename) {
  const invalid = () => {
    const line = key.locationData.first_line + 1;
    throw Object.assign(new SyntaxError(`${filename || '<anonymous>.type'}:${line}: invalid primary key for ${model.name}`), {
      code: 'SCRIBA_INVALID_KEY',
    });
  };
  const checkField = (name, node) => {
    const field = model.fields.find(field => field.name === name);
    const actual = infer(node);
    if (!actual) return;
    const expected = { String: 'string', Int: 'number', Float: 'number', Boolean: 'boolean', DateTime: 'string' }[field.type];
    if (actual.type === 'null' || actual.type === 'undefined'
      || (field.type !== 'DateTime' && expected && actual.type !== expected)
      || (field.type === 'Int' && !Number.isSafeInteger(actual.value))) invalid();
  };
  const { fields, composite } = model.primaryKey;
  if (!composite) return checkField(fields[0], key);
  const object = unwrap(key);
  if (!(object instanceof Obj)) {
    if (infer(key)) invalid();
    return;
  }
  const properties = new Map();
  for (const entry of object.properties) {
    const shorthand = unwrap(entry);
    if (shorthand instanceof IdentifierLiteral) {
      properties.set(shorthand.value, entry);
      continue;
    }
    if (!(entry instanceof Assign)) return;
    const name = unwrap(entry.variable).value;
    if (typeof name !== 'string') return;
    const literal = infer(entry.variable);
    const field = literal?.value ?? name;
    properties.set(field, entry.value);
  }
  if (properties.size !== fields.length || fields.some(field => !properties.has(field))) invalid();
  for (const field of fields) checkField(field, properties.get(field));
}

module.exports = { lowerPrimaryKeyReads };
