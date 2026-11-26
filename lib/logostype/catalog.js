'use strict';

const RESOURCE_CATALOG_VERSION = 1;

function createResourceCatalog(compileResource, { package: packageName, sources, globals }) {
  const resources = new Map();
  const calls = [];
  for (const { filename, source } of sources) {
    const result = compileResource(source, { filename, capabilities: { package: packageName, globals } });
    for (const { kind, name, params, returns, line } of result.declarations) {
      const identity = `${packageName}::${kind}:${name}`;
      const origin = { filename, line };
      if (resources.has(identity)) {
        const previous = resources.get(identity).origin;
        throw new SyntaxError(`${filename}:${line}: duplicate resource ${identity} (first declared at ${previous.filename}:${previous.line})`);
      }
      resources.set(identity, { identity, kind, name, params, returns, origin });
    }
    for (const { name, line } of result.capabilities) {
      calls.push({ capability: name, origin: { filename, line } });
    }
  }
  const names = new Map();
  for (const resource of resources.values()) {
    const matches = names.get(resource.name) || [];
    matches.push(resource);
    names.set(resource.name, matches);
  }
  const localPrefix = `${packageName}::`;
  const dependencies = new Set();
  for (const call of calls) {
    if (!call.capability.startsWith(localPrefix)) {
      dependencies.add(call.capability.split('::')[0]);
      continue;
    }
    const reference = call.capability.slice(localPrefix.length);
    const matches = reference.includes(':')
      ? [resources.get(call.capability)].filter(Boolean)
      : names.get(reference) || [];
    const location = `${call.origin.filename}:${call.origin.line}`;
    if (!matches.length) throw new SyntaxError(`${location}: unknown resource ${call.capability}`);
    if (matches.length > 1) throw new SyntaxError(`${location}: ambiguous resource ${call.capability}`);
    call.target = matches[0].identity;
  }
  return {
    version: RESOURCE_CATALOG_VERSION,
    package: packageName,
    resources: [...resources.values()],
    dependencies: [...dependencies].sort(),
    calls,
  };
}

module.exports = { RESOURCE_CATALOG_VERSION, createResourceCatalog };
