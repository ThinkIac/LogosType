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
