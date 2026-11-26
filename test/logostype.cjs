const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const language = require('..');
function run(source) { const compiled = language.compileResource(source, {filename:'/tmp/example.type'}); const module = {exports:{}}; vm.runInNewContext(compiled.js, {module, exports:module.exports}); return {...compiled, exports:module.exports}; }
test('provider aliases and metadata with no Logos dependency', () => {
 for (const keyword of ['module','type']) {
  const result = run(`${keyword} task = (resource) ->\n  @tag {number} interval\n  { prepare: -> resource.metadata.interval }\n`);
  assert.match(result.docs.task, /@register module task/);
  assert.equal(result.exports.task({metadata:{interval:60000}}).prepare(), 60000);
 }
});
test('typed signatures, overrides, literals and automatic export', () => {
 const r = run('tool getUser = (ID: User.ID, serverName: string = "a,b"): User? ->\n  @param ID - Identificador escolhido\n  @description "Busca usuário"\n  {ID, serverName}\n');
 assert.match(r.docs.getUser, /@params \{User.ID\} ID - Identificador escolhido/);
 assert.match(r.docs.getUser, /@returns \{User\?\}/);
 assert.deepEqual(JSON.parse(JSON.stringify(r.exports.getUser(7))), {ID:7,serverName:'a,b'});
});
test('void discards implicit return and maps preserve original source', async () => {
 const source = 'task clean = (): void ->\n  @interval 60000\n  42\n'; const r = run(source);
 assert.equal(r.exports.clean(), undefined);
 const map = JSON.parse(Buffer.from(r.js.match(/base64,([^\n]+)/)[1], 'base64'));
 assert.deepEqual(map.sourcesContent, [source]);
});
test('legacy blocks and helpers preserve CoffeeScript behavior', () => {
 const r = run('helper = -> 42\n###\n# @register tool answer\n###\nanswer = -> helper()\n');
 assert.equal(r.exports.answer(),42); assert.equal(r.exports.helper,undefined);
 assert.match(r.docs.answer, /@register tool answer/);
});
test('ignores declarations inside heredocs and comments', () => {
 const r = run("text = '''\ntool fake = (): number -> 42\n'''\n# module fake = (resource) ->\n");
 assert.equal(Object.keys(r.docs).length,0); assert.equal(Object.keys(r.exports).length,0);
});
test('diagnoses missing types, misplaced directives and export conflicts', () => {
 assert.throws(()=>run('tool x = (id): number -> id'), /parameter requires/);
 assert.throws(()=>run('tool x = (id: number) -> id'), /return type/);
 assert.throws(()=>run('tool x = (): number ->\n  1\n  @interval 20'), /directives must precede/);
 assert.throws(()=>run('tool x = (): number -> 1\nexports.x = -> 2'), /conflicting export/);
});
test('union signatures and async void exports retain their contracts', async () => {
 const r = run('sample choose = (value: ("a"|"b")): ("a"|"b") -> value\n\ntask finish = (): void ->\n  await Promise.resolve 42\n');
 assert.match(r.docs.choose, /@returns \{\("a"\|"b"\)\}/);
 assert.equal(r.exports.choose('a'),'a');
 assert.equal(await r.exports.finish(),undefined);
});
test('directives after literal statements are rejected', () => {
 assert.throws(()=>run('sample x = (): string ->\n  "value"\n  @description "late"\n'),/directives must precede/);
});
test('capability lowering resolves local calls before remote events', async () => {
 const source = 'local = (id) -> "local:" + id\n\nmodule.exports.result = ->\n  a = await local 12\n  b = await getCustomPrompt "hello"\n  c = await identity.user.get 12\n  [a, b, c]\n';
 const compiled = language.compileResource(source, {filename:'/tmp/capabilities.type', capabilities:{package:'agent'}});
 assert.deepEqual(compiled.capabilities.map(call => call.name), ['agent::getCustomPrompt', 'identity::user:get']);
 const events = [];
 const $ = language.createCapabilityHost({package:'agent', dispatch: async event => {
   events.push(event); if (event.capability === 'agent::getCustomPrompt') return {found:true, value:'remote:hello'};
   if (event.capability === 'identity::user:get') return {found:true, value:{id:event.args[0]}};
   return {found:false};
 }});
 const module = {exports:{}};
 vm.runInNewContext(compiled.js, {module, exports:module.exports, $});
 assert.deepEqual(JSON.parse(JSON.stringify(await module.exports.result())), ['local:12','remote:hello',{id:12}]);
 assert.equal(events[0].caller, 'agent');
 assert.equal(events[0].protocol, language.CAPABILITY_PROTOCOL);
});
test('capability host makes missing remote events explicit', async () => {
 const $ = language.createCapabilityHost({package:'agent', dispatch: async () => ({found:false})});
 await assert.rejects(() => $('not a capability'), {code:'LOGOS_INVALID_CAPABILITY'});
 await assert.rejects(() => $('agent::tool:missing'), {code:'LOGOS_CAPABILITY_NOT_FOUND'});
});
test('capabilities preserve function parameters and canonical package names', async () => {
 const source = 'run = (getCustomPrompt) ->\n  getCustomPrompt "local"\n\nanswer = await getStatus "remote"\n';
 const compiled = language.compileResource(source, {capabilities:{package:'agent-runtime'}});
 assert.deepEqual(compiled.capabilities.map(call => call.name), ['agent-runtime::getStatus']);
 const $ = language.createCapabilityHost({package:'agent-runtime', dispatch: async event => ({found:true, value:event.capability})});
 assert.equal(await $('agent-runtime::answer', 'x'), 'agent-runtime::answer');
});

test('indexes resource signatures, call sites and origins across source files', () => {
  const catalog = language.compileCatalog({
    package: 'agenda',
    sources: [
      { filename: 'read.type', source: 'query read = (id: number): string ->\n  await identity.user.get id' },
      { filename: 'write.type', source: 'action write = (): void ->\n  null' },
    ],
  });
  assert.equal(catalog.version, language.RESOURCE_CATALOG_VERSION);
  assert.deepEqual(catalog.resources.map(resource => resource.identity), ['agenda::query:read', 'agenda::action:write']);
  assert.equal(catalog.resources[0].params[0].type, 'number');
  assert.equal(catalog.resources[0].returns, 'string');
  assert.deepEqual(catalog.resources[0].origin, { filename: 'read.type', line: 1 });
  assert.deepEqual(catalog.calls, [{ capability: 'identity::user:get', origin: { filename: 'read.type', line: 2 } }]);
});

test('reports both origins when a canonical resource is duplicated', () => {
  const source = 'query read = (): number -> 1';
  assert.throws(() => language.compileCatalog({
    package: 'agenda',
    sources: [{ filename: 'one.type', source }, { filename: 'two.type', source }],
  }), /two\.type:1: duplicate resource agenda::query:read.*one\.type:1/);
});

test('links local resource calls across files and diagnoses missing resources', () => {
  const sources = [
    { filename: 'caller.type', source: 'query caller = (id: number): number ->\n  await read id' },
    { filename: 'callee.type', source: 'query read = (id: number): number -> id' },
  ];
  const catalog = language.compileCatalog({ package: 'agenda', sources });
  assert.equal(catalog.calls[0].target, 'agenda::query:read');
  assert.throws(() => language.compileCatalog({ package: 'agenda', sources: sources.slice(0, 1) }),
    /caller\.type:2: unknown resource agenda::read/);
});
