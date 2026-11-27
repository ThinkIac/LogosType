# logos-capabilities/v1

LógosType continua independente de Lógos, Scriba, banco de dados e rede. Este
protocolo define somente a ponte opcional entre código `.type` e um host.

O host chama `compileResource` com sua identidade já conhecida:

```js
const compiled = compileResource(source, {
  capabilities: { package: 'agent-runtime', globals: ['Promise'] }
});
```

Com essa opção, uma chamada para uma função local declarada preserva CoffeeScript
normal. Uma chamada sem declaração vira evento do pacote atual; uma chamada com
caminho pontuado vira evento do pacote na raiz do caminho:

```coffee
format = (value) -> "ok: #{value}"
local = await format 12
prompt = await getCustomPrompt message
user = await identity.user.get 12
```

```js
// format continua local
await $('agent-runtime::getCustomPrompt', message)
await $('identity::user:get', 12)
```

O código fonte nunca informa a identidade de quem chama. O host cria `$` com
`createCapabilityHost({ package, dispatch })`; `dispatch` recebe
`{ protocol, caller, capability, args }` e retorna `{ found: true, value }`.
Quando retornar `found: false`, a ponte lança `LOGOS_CAPABILITY_NOT_FOUND`.
Autorização, descoberta do provedor, auditoria e entrega são responsabilidades do
host. Para conceder uma biblioteca JavaScript, o host deve listar sua raiz em
`globals`; sem essa concessão uma chamada não declarada é uma capacidade remota.

`package::resource:action` é formato de transporte. `::` não é sintaxe autoral,
pois é reservado pelo CoffeeScript para `prototype`.

## Response extension hooks

A typed response declares which phases it opens. A hook names its canonical
target and destructures only the fields it uses.

```coffee
response compose = (message: string, suffix: string = "!"): string? ->
  @extensions before
  @extensions transform
  @extensions after
  message + suffix

extensionHook audit = before agent::response:compose ({message, suffix}, context) ->
  # suffix can be undefined before the provider applies its default.
  context.signal.throwIfAborted()

extensionHook customize = transform agent::response:compose ({result}) ->
  if result? then result.toUpperCase() else undefined
```

The catalog checks the selected names against the target's signature when
the target catalog is available. Before receives named inputs, transform and
after receive the single named field `result`, with the target's return type.
The catalog checks inferable transform returns against that type, including
nullable returns. A transform may return `undefined` to keep the result.

The optional second binding receives host context, independently of input
fields. The host supplies the abort signal, event and flow ID and resolves
identity and authority from execution context. When target contracts or
expression types are unavailable to the compiler, the host remains responsible
for checking runtime values, deciding whether delivery is authorized, and
validating every replacement.
