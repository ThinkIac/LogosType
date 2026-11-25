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
