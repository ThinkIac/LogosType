'use strict';

const { accepts, validateArguments, valueType, splitUnion } = require('./contracts');

const RESOURCE_CATALOG_VERSION = 1;

function createResourceCatalog(compileResource, { package: packageName, sources, globals, externalCatalogs = [] }) {
  if (typeof packageName !== 'string' || !/^[a-z][a-z0-9-]*$/i.test(packageName)) {
    throw new TypeError('package must be a valid canonical package name');
  }
  const resources = new Map();
  const calls = [];
  const argumentTypes = new Map();
  const callSites = new Map();
  const returnChecks = [];
  const external = new Map();
  for (const catalog of externalCatalogs) {
    const lookup = indexCatalog(catalog, catalog?.package);
    if (catalog.package === packageName || external.has(catalog.package)) {
      throw new TypeError(`duplicate catalog for ${catalog.package}`);
    }
    external.set(catalog.package, lookup);
  }
  for (const { filename, source } of sources) {
    let analysis;
    const result = compileResource(source, { filename, capabilities: { package: packageName, globals } },
      value => { analysis = value; });
    returnChecks.push(...analysis.returns.map(check => ({ ...check, filename })));
    for (const { kind, name, params, returns, line } of result.declarations) {
      const identity = `${packageName}::${kind}:${name}`;
      const origin = { filename, line };
      if (resources.has(identity)) {
        const previous = resources.get(identity).origin;
        throw new SyntaxError(`${filename}:${line}: duplicate resource ${identity} (first declared at ${previous.filename}:${previous.line})`);
      }
      resources.set(identity, { identity, kind, name, params, returns, origin });
    }
    for (const capability of result.capabilities) {
      const call = { capability: capability.name, origin: { filename, line: capability.line } };
      calls.push(call);
      argumentTypes.set(call, analysis.argumentsByCall.get(capability));
      callSites.set(capability, call);
    }
  }
  const local = indexResources(resources.values());
  const dependencies = new Set();
  const targets = new Map();
  for (const call of calls) {
    const [targetPackage] = call.capability.split('::');
    const lookup = targetPackage === packageName ? local : external.get(targetPackage);
    if (targetPackage !== packageName) dependencies.add(targetPackage);
    if (!lookup) continue;
    const location = `${call.origin.filename}:${call.origin.line}`;
    const report = message => { throw new SyntaxError(`${location}: ${message}`); };
    const target = findResource(lookup, call.capability, report);
    call.target = target.identity;
    targets.set(call, target);
    const args = argumentTypes.get(call);
    if (args) validateArguments(target, args, message => report(`${call.capability}: ${message}`));
  }
  for (const { signature, line, filename, actual, call } of returnChecks) {
    const target = targets.get(callSites.get(call));
    const incompatible = accepts(signature.returns, actual) === false ||
      (target?.returns && incompatibleReturn(signature.returns, target.returns));
    if (incompatible) throw new SyntaxError(`${filename}:${line}: return of ${signature.name} expects ${signature.returns}`);
  }
  return {
    version: RESOURCE_CATALOG_VERSION,
    package: packageName,
    resources: [...resources.values()],
    dependencies: [...dependencies].sort(),
    calls,
  };
}

function indexResources(resources) {
  const identities = new Map();
  const names = new Map();
  for (const resource of resources) {
    if (identities.has(resource.identity)) throw new TypeError(`duplicate resource ${resource.identity}`);
    identities.set(resource.identity, resource);
    const matches = names.get(resource.name) || [];
    matches.push(resource);
    names.set(resource.name, matches);
  }
  return { identities, names };
}

function indexCatalog(catalog, packageName) {
  if (!catalog || catalog.version !== RESOURCE_CATALOG_VERSION ||
      typeof packageName !== 'string' || catalog.package !== packageName ||
      !Array.isArray(catalog.resources) || catalog.resources.some(resource =>
        !resource || typeof resource.kind !== 'string' || typeof resource.name !== 'string' ||
        resource.identity !== `${packageName}::${resource.kind}:${resource.name}` ||
        !Array.isArray(resource.params) || resource.params.some(param =>
          !param || typeof param.name !== 'string' ||
          (resource.kind !== 'module' && typeof param.type !== 'string')) ||
        (resource.kind !== 'module' && typeof resource.returns !== 'string'))) {
    throw new TypeError(`missing or incompatible resource catalog for ${packageName}`);
  }
  return indexResources(catalog.resources);
}

function findResource(lookup, capability, report) {
  const reference = capability.split('::')[1];
  const matches = reference.includes(':')
    ? [lookup.identities.get(capability)].filter(Boolean)
    : lookup.names.get(reference) || [];
  if (!matches.length) report(`unknown resource ${capability}`);
  if (matches.length > 1) report(`ambiguous resource ${capability}`);
  return matches[0];
}

function incompatibleReturn(expected, provided) {
  return splitUnion(provided).some(part => {
    const type = part.trim();
    if (type === 'void') return accepts(expected, { type: 'undefined' }) === false;
    if (/^(number|string|boolean|bigint|symbol|function|null|undefined|object|array)$/.test(type)) {
      // A known disjoint primitive is incompatible. Broad object contracts may include arrays.
      return type !== 'object' && accepts(expected, { type }) === false;
    }
    try { return accepts(expected, valueType(JSON.parse(type))) === false; }
    catch { return false; }
  });
}

function prepareCapabilityInvocation(capability, args, catalog, matchesType) {
  const fail = message => {
    const error = new TypeError(`${capability}: ${message}`);
    error.code = 'LOGOS_CONTRACT_MISMATCH';
    throw error;
  };
  let lookup;
  try { lookup = indexCatalog(catalog, capability.split('::')[0]); }
  catch (error) { fail(error.message); }
  const target = findResource(lookup, capability, fail);
  const resolveType = (type, value) => matchesType?.(type, value, target) === true;
  validateArguments(target, args.map(arg => valueType(arg)), fail, resolveType);
  return value => {
    if (target.returns && accepts(target.returns, valueType(value), resolveType) !== true) {
      fail(`return expects ${target.returns}`);
    }
  };
}

module.exports = { RESOURCE_CATALOG_VERSION, createResourceCatalog, prepareCapabilityInvocation };
