'use strict';

const SCHEMA_CATALOG_VERSION = 1;
const builtins = new Map(Object.entries({
  String: 'string', Int: 'number', Float: 'number', Boolean: 'boolean',
  BigInt: 'bigint', Json: 'any',
}));

function schemaError(code, message) {
  return Object.assign(new SyntaxError(message), { code });
}

function createSchemaCatalog(sources) {
  const models = new Map();
  for (const { filename, source } of sources) {
    if (!/\.(schema|scriba|prisma)$/i.test(filename)) {
      throw schemaError('LOGOS_SCHEMA_UNSUPPORTED', `unsupported schema: ${filename}`);
    }
    // Keep documentation and quoted strings intact while consuming comments.
    const tokens = source.match(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|[A-Za-z_]\w*|@@|[^\s]/g) || [];
    let documentation = [];
    const comments = token => token?.startsWith('//') || token?.startsWith('/*');
    for (let i = 0; i < tokens.length;) {
      const kind = tokens[i++];
      if (comments(kind)) {
        if (kind.startsWith('///')) documentation.push(kind.slice(3).trim());
        continue;
      }
      const name = tokens[i++];
      if (!/^(model|view|type|enum|datasource|generator)$/.test(kind) ||
          !name || !/^[A-Za-z_]\w*$/.test(name) || tokens[i++] !== '{') {
        throw schemaError('LOGOS_SCHEMA_SYNTAX', `${filename}: expected schema declaration near ${kind}`);
      }
      const description = documentation.join('\n');
      documentation = [];
      const start = i;
      let depth = 1;
      while (i < tokens.length && depth) {
        const token = tokens[i++];
        if (token === '{') depth++;
        if (token === '}') depth--;
      }
      if (depth) throw schemaError('LOGOS_SCHEMA_SYNTAX', `${filename}: unclosed declaration ${name}`);
      if (kind !== 'model' && kind !== 'view' && kind !== 'type') continue;
      if (models.has(name)) {
        throw schemaError('LOGOS_SCHEMA_CONFLICT', `${filename}: conflicting model ${name} in ${models.get(name).filename}`);
      }
      models.set(name, { name, kind, filename, description, ...readMembers(tokens.slice(start, i - 1), filename, name) });
    }
  }
  return { version: SCHEMA_CATALOG_VERSION, models: [...models.values()] };
}

function readMembers(tokens, filename, model) {
  const fields = new Map();
  const keys = [];
  let documentation = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i++];
    if (token.startsWith('///')) {
      documentation.push(token.slice(3).trim());
      continue;
    }
    if (token.startsWith('//') || token.startsWith('/*')) continue;
    if (token === '@@') {
      const attribute = tokens[i++];
      const args = readArguments();
      if (attribute === 'id' || attribute === 'unique') {
        const members = [];
        let depth = 0;
        for (const [index, value] of args.entries()) {
          if (depth === 1 && ['[', ','].includes(args[index - 1])) members.push(value);
          if (value === '[' || value === '(') depth++;
          if (value === ']' || value === ')') depth--;
          if (!depth && value === ']') break;
        }
        keys.push({ kind: attribute, fields: members });
      }
      documentation = [];
      continue;
    }
    const type = tokens[i++];
    if (!/^[A-Za-z_]\w*$/.test(token) || !type || !/^[A-Za-z_]\w*$/.test(type)) {
      throw schemaError('LOGOS_SCHEMA_SYNTAX', `${filename}: invalid field in ${model} near ${token}`);
    }
    if (type === 'Unsupported') readArguments();
    const list = tokens[i] === '[' && tokens[i + 1] === ']';
    if (list) i += 2;
    const nullable = tokens[i] === '?';
    if (nullable) i++;
    if (fields.has(token)) throw schemaError('LOGOS_SCHEMA_CONFLICT', `${filename}: duplicate field ${model}.${token}`);
    fields.set(token, { name: token, type, list, nullable, description: documentation.join('\n') });
    documentation = [];
    while (tokens[i] === '@') {
      i++;
      const attribute = tokens[i++];
      if (tokens[i] === '.') i += 2;
      readArguments();
      if (attribute === 'id' || attribute === 'unique') keys.push({ kind: attribute, fields: [token] });
    }
  }
  for (const key of keys) {
    if (!key.fields.length || key.fields.some(field => !fields.has(field))) {
      throw schemaError('LOGOS_SCHEMA_SYNTAX', `${filename}: invalid ${key.kind} key in ${model}`);
    }
  }
  if (keys.filter(key => key.kind === 'id').length > 1) {
    throw schemaError('LOGOS_SCHEMA_CONFLICT', `${filename}: multiple primary keys in ${model}`);
  }
  return { fields: [...fields.values()], keys };

  function readArguments() {
    if (tokens[i] !== '(') return [];
    const start = ++i;
    let depth = 1;
    while (i < tokens.length && depth) {
      const token = tokens[i++];
      if (token === '(') depth++;
      if (token === ')') depth--;
    }
    if (depth) throw schemaError('LOGOS_SCHEMA_SYNTAX', `${filename}: unclosed attribute in ${model}`);
    return tokens.slice(start, i - 1);
  }
}

function createSchemaTypeResolver(catalog) {
  const models = new Map(catalog.models.map(model => [model.name, new Map(model.fields.map(field => [field.name, field]))]));
  return (type, location) => {
    const [model, name] = type.split('.');
    if (!models.has(model)) {
      throw schemaError('LOGOS_SCHEMA_MODEL_NOT_FOUND', `${location}: unknown schema model ${model} in ${type}`);
    }
    const field = models.get(model).get(name);
    if (!field) {
      throw schemaError('LOGOS_SCHEMA_FIELD_NOT_FOUND', `${location}: unknown schema field ${type}`);
    }
    return (builtins.get(field.type) || field.type) + (field.list ? '[]' : '') + (field.nullable ? '?' : '');
  };
}

module.exports = { SCHEMA_CATALOG_VERSION, createSchemaCatalog, createSchemaTypeResolver };
