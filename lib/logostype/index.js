"use strict";
const coffee = require('../coffeescript');
const { inspectContracts } = require('./contracts');

// Split signatures without breaking unions, arrays, quoted literals or defaults.
function split(text, delimiter) {
  const result = []; let start = 0, depth = 0, quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if ('"\''.includes(c)) { quote = c; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === delimiter && depth === 0) { result.push(text.slice(start, i).trim()); start = i + 1; }
  }
  result.push(text.slice(start).trim()); return result;
}

// Mask literals/comments while retaining offsets and line breaks. A declaration
// embedded in a heredoc or a comment must never become an exported resource.
function mask(source) {
  let out = '', quote = null;
  for (let i = 0; i < source.length;) {
    if (quote) {
      if (source.startsWith(quote, i)) { out += ' '.repeat(quote.length); i += quote.length; quote = null; }
      else if (source[i] === '\\' && quote !== '###') { out += ' '; i++; if (i < source.length) out += source[i++] === '\n' ? '\n' : ' '; }
      else out += source[i++] === '\n' ? '\n' : ' ';
    } else {
      const q = ['///', '###', String.fromCharCode(34).repeat(3), String.fromCharCode(39).repeat(3), '```', String.fromCharCode(34), String.fromCharCode(39), '`'].find(q => source.startsWith(q, i));
      if (q) { quote = q; out += (q === '###' ? ' ' : 'X') + ' '.repeat(q.length - 1); i += q.length; }
      else if (source[i] === '#') { while (i < source.length && source[i] !== '\n') { out += ' '; i++; } }
      else out += source[i++];
    }
  }
  return out;
}

const CAPABILITY_PROTOCOL = 'logos-capabilities/v1';
const identifier = /^[A-Za-z_$][\w$]*$/;
const packageName = /^[a-z][a-z0-9-]*$/i;

function capabilityError(message, code = 'LOGOS_CAPABILITY_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

// This source-to-source lowering pass runs only when a host opts into the
// capability protocol. A declared binding always wins over a remote event.
function lowerCapabilities(source, options) {
  const capabilityOptions = options.capabilities;
  if (!capabilityOptions) return { source, calls: [] };
  const caller = capabilityOptions.package;
  if (typeof caller !== 'string' || !packageName.test(caller)) {
    throw capabilityError('capabilities.package must be a valid canonical package name');
  }
  const visibleLines = mask(source).split('\n');
  const local = new Set(capabilityOptions.globals || []);
  for (const match of visibleLines.join('\n').matchAll(/^\s*([A-Za-z_$][\w$]*)\s*=/gm)) local.add(match[1]);
  // Parameters shadow capability names in their CoffeeScript function body.
  // Conservatively treating them as local for the whole resource prevents a
  // host event from replacing an explicit dependency.
  for (const match of visibleLines.join('\n').matchAll(/\(([^)]*)\)\s*(?:->|=>)/g)) {
    for (const param of match[1].split(',')) {
      const name = param.trim().match(/^([A-Za-z_$][\w$]*)/);
      if (name) local.add(name[1]);
    }
  }
  const calls = [];
  const prefix = '(\\s*(?:(?:[A-Za-z_$][\\w$]*\\s*=\\s*)|(?:return\\s+))?)';
  const dotted = new RegExp('^' + prefix + '(await\\s+)?([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)+)(\\s+)(.+)$');
  const bare = new RegExp('^' + prefix + '(await\\s+)?([A-Za-z_$][\\w$]*)(\\s+)(.+)$');
  function lowerCall(before, awaiting, name, args, line) {
    const named = /^named\s+(?=\{)/.test(args);
    calls.push({ name, line, ...(named && { named }) });
    const bridge = named ? '$.named' : '$';
    return `${before}${awaiting}${bridge} ${JSON.stringify(name)}, ${named ? args.replace(/^named\s+/, '') : args}`;
  }
  const transformed = source.split('\n').map((line, index) => {
    const code = visibleLines[index];
    // A property assignment is never a call expression. In particular this
    // keeps CommonJS exports compatible with ordinary CoffeeScript.
    if (/^\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\s*=/.test(code)) return line;
    let match = code.match(dotted);
    if (match && match[5].trim()) {
      const [, before, awaiting = '', path, , args] = match;
      const parts = path.split('.');
      if (local.has(parts[0])) return line;
      const name = `${parts[0]}::${parts.slice(1, -1).join('.')}:${parts.at(-1)}`;
      return lowerCall(before, awaiting, name, line.slice(match[0].length - args.length), index + 1);
    }
    match = code.match(bare);
    if (!match || !match[5].trim()) return line;
    const [, before, awaiting = '', name, , args] = match;
    if (local.has(name) || ['if', 'unless', 'while', 'for', 'switch', 'throw', 'return', 'await'].includes(name)) return line;
    const capability = `${caller}::${name}`;
    return lowerCall(before, awaiting, capability, line.slice(match[0].length - args.length), index + 1);
  }).join('\n');
  return { source: transformed, calls };
}

// The Runtime owns identity and authorization. This adapter only specifies the
// bridge that it may expose to compiled code; the compiler starts no service.
function createCapabilityHost({ package: caller, dispatch, catalogForPackage, matchesType }) {
  if (typeof caller !== 'string' || !packageName.test(caller)) {
    throw capabilityError('package must be a valid canonical package name');
  }
  if (typeof dispatch !== 'function') throw capabilityError('dispatch must be a function');
  async function invoke(capability, args, named) {
    if (typeof capability !== 'string' || !/^[a-z][a-z0-9-]*::(?:[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*:[A-Za-z_$][\w$]*)$/i.test(capability)) {
      throw capabilityError(`invalid capability ${JSON.stringify(capability)}`, 'LOGOS_INVALID_CAPABILITY');
    }
    const catalog = await catalogForPackage?.(capability.split('::')[0]);
    if (named) {
      if (args.length !== 1) throw capabilityError('expected one named argument object', 'LOGOS_CONTRACT_MISMATCH');
      args = bindNamedInvocation(capability, args[0], catalog);
    }
    const validateReturn = catalogForPackage && prepareCapabilityInvocation(capability, args, catalog, matchesType);
    const outcome = await dispatch({ protocol: CAPABILITY_PROTOCOL, caller, capability, args });
    if (!outcome || outcome.found !== true) {
      throw capabilityError(`capability ${capability} is unavailable to package ${caller}`, 'LOGOS_CAPABILITY_NOT_FOUND');
    }
    if (!validateReturn) return outcome.value;
    const value = await outcome.value;
    validateReturn(value);
    return value;
  }
  const bridge = (capability, ...args) => invoke(capability, args, false);
  Object.defineProperty(bridge, 'named', { value: (capability, ...fields) => invoke(capability, fields, true) });
  return bridge;
}

function compileResource(source, options = {}, inspect) {
  const filename = options.filename || '<anonymous>.type';
  const fail = (line, message) => { throw new SyntaxError(`${filename}:${line + 1}: ${message}`); };
  const lines = source.split('\n'), visible = mask(source).split('\n');
  const docs = Object.create(null), declarations = [], automatic = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!/^[A-Za-z_$][\w$]*\s+[A-Za-z_$][\w$]*\s*=/.test(visible[i])) continue;
    const match = lines[i].match(/^([A-Za-z_$][\w$]*)\s+([A-Za-z_$][\w$]*)\s*=\s*\((.*?)\)\s*(?::\s*(.+?))?\s*(->|=>)\s*(.*)$/);
    if (!match) fail(i, 'expected kind name = (parameters): ReturnType ->');
    const [, kind, name, args, returns, arrow, body] = match;
    if (automatic.has(name)) fail(i, `duplicate resource binding ${name}`);
    const provider = kind === 'module' || kind === 'type';
    if (!provider && !returns) fail(i, `resource ${name} requires a return type`);
    const params = [], plain = [];
    for (const arg of args.trim() ? split(args, ',') : []) {
      const m = arg.match(/^([A-Za-z_$][\w$]*)(?:\s*:\s*(.+?))?(?:\s*=\s*(.+))?$/);
      if (!m || (!provider && !m[2])) fail(i, `parameter requires name: Type: ${arg}`);
      if (params.some(p => p.name === m[1])) fail(i, `duplicate parameter ${m[1]}`);
      params.push({ name: m[1], type: m[2], default: m[3], description: '' });
      plain.push(m[1] + (m[3] === undefined ? '' : ' = ' + m[3]));
    }
    const tags = [`@register ${provider ? 'module' : kind} ${name}`];
    if (provider) tags.push('@provider resource');
    let executable = !!body.trim(), directiveIndent = null;
    for (let j = i + 1; j < lines.length; j++) {
      if (visible[j].trim() && !/^\s/.test(visible[j])) break;
      const directive = visible[j].match(/^(\s+)@([A-Za-z_]\w*)\s+/);
      if (!directive) { if (visible[j].trim()) executable = true; continue; }
      if (executable) fail(j, 'directives must precede executable statements');
      if (directiveIndent !== null && directive[1].length !== directiveIndent) fail(j, 'directives must share the body indentation');
      directiveIndent = directive[1].length;
      const key = directive[2], value = lines[j].slice(directive[0].length).trim();
      if (key === 'param') {
        const p = value.match(/^([\w$]+)\s+-\s+(.+)$/);
        const param = p && params.find(param => param.name === p[1]);
        if (!param) fail(j, '@param requires a declared parameter followed by - description');
        param.description = p[2];
      } else {
        if (['register', 'provider', 'params', 'returns'].includes(key)) fail(j, `@${key} is generated by the declaration`);
        let normalized = value;
        if (key !== 'tag' && /^("|')/.test(value)) {
          try { normalized = value[0] === '"' ? JSON.parse(value) : value.slice(1, -1); }
          catch { fail(j, 'invalid literal directive'); }
        }
        tags.push(`@${key} ${normalized}`);
      }
      lines[j] = ''; visible[j] = '';
    }
    if (!provider) {
      if (!params.length) tags.push('@params []');
      for (const param of params) tags.push(`@params {${param.type}} ${param.default === undefined ? param.name : '[' + param.name + '=' + param.default + ']'}${param.description ? ' - ' + param.description : ''}`);
      tags.push(`@returns {${returns}}`);
    }
    docs[name] = tags.join('\n');
    declarations.push({ kind: provider ? 'module' : kind, name, params, returns, line: i + 1 });
    automatic.add(name);
    lines[i] = `${name} = (${plain.join(', ')}) ${arrow} ${body}`;
  }
  const declared = lines.join('\n');
  const lowered = lowerCapabilities(declared, options);
  const transformed = lowered.source;
  // Legacy ### registration remains supported by the same public compiler API.
  for (const token of coffee.tokens(transformed, { filename })) {
    for (const comment of token.comments || []) {
      if (!comment.here || comment.locationData.first_column !== 0) continue;
      const assignment = transformed.slice(comment.locationData.range[1]).match(/^\s*(?:(?:module\.)?exports\.([\w$]+)|([\w$]+))\s*=/);
      if (!assignment) continue;
      const name = assignment[1] || assignment[2];
      const doc = comment.content.split('\n').map(line => line.trim().replace(/^[#*]\s?/, '')).join('\n');
      docs[name] = docs[name] ? doc + '\n' + docs[name] : doc;
      if (/^@register(?:[ \t]|_)/m.test(doc) && assignment[2]) automatic.add(name);
    }
  }
  if (inspect) inspect(inspectContracts(coffee.nodes(transformed, { filename }), declarations, lowered.calls));
  let js = coffee.compile(transformed, { ...options, bare: true, inlineMap: true });
  const exportsCode = [...automatic].map(name => `\nif (typeof ${name} !== "function") throw new TypeError(${JSON.stringify(filename + ': @register requires function ' + name)});\nif (Object.prototype.hasOwnProperty.call(module.exports, ${JSON.stringify(name)}) && module.exports[${JSON.stringify(name)}] !== ${name}) throw new Error(${JSON.stringify(filename + ': conflicting export ' + name)});\nmodule.exports[${JSON.stringify(name)}] = ${name};`).join('\n');
  // Void signatures discard the value of CoffeeScript's implicit return.
  const voidExports = declarations.filter(d => d.returns === 'void').map(d => `module.exports[${JSON.stringify(d.name)}] = function(...args) { const result = ${d.name}.apply(this, args); return result && typeof result.then === "function" ? Promise.resolve(result).then(() => undefined) : undefined; };`).join('\n');
  js = js.replace(/(?=^\/\/# sourceMappingURL=)/m, exportsCode + '\n' + voidExports + '\n');
  js = js.replace(/(sourceMappingURL=data:application\/json;base64,)([^\n]+)/, (_, prefix, data) => {
    const map = JSON.parse(Buffer.from(data, 'base64').toString());
    map.sourcesContent = [source];
    return prefix + Buffer.from(JSON.stringify(map)).toString('base64');
  });
  return { js, docs, declarations, capabilities: lowered.calls };
}
const { RESOURCE_CATALOG_VERSION, createResourceCatalog, prepareCapabilityInvocation, bindNamedInvocation } = require('./catalog');
function compileCatalog(options) {
  return createResourceCatalog(compileResource, options);
}

const { SCHEMA_CATALOG_VERSION, createSchemaCatalog } = require('./schema');

module.exports = { ...coffee, SCHEMA_CATALOG_VERSION, createSchemaCatalog, CAPABILITY_PROTOCOL, RESOURCE_CATALOG_VERSION, compileResource, compileCatalog, createCapabilityHost };
