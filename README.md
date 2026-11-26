# LógosType

LógosType é uma linguagem de recursos declarativos baseada em CoffeeScript 2.
O pacote npm chama-se **`logostype`**. O compilador funciona sem importar Lógos;
o host interpreta e valida as declarações e fornece as capacidades.

```bash
npm install ThinkIac/LogosType#main
```

Enquanto este PR estiver aberto, a implementação está na branch:

```bash
npm install ThinkIac/LogosType#feat/declarative-typed-resources
```

## Tudo começa por um módulo

`module` e `type` são aliases completos. Ambos declaram o provedor de um recurso.
O provedor define o contrato dos metadados com `@tag` e recebe cada recurso normalizado.

```coffee
module task = (resource) ->
  @description "Executa tarefas periodicamente"
  @tag {number} interval

  timer = null
  {
    prepare: ->
      throw new Error "Intervalo inválido" unless resource.metadata.interval > 0
    commit: -> timer = setInterval resource.handler, resource.metadata.interval
    rollback: -> clearInterval timer if timer?
    dispose: -> clearInterval timer if timer?
  }

task cacheClean = (): void ->
  @interval 60000
  cache.clear()
```

O host precisa fornecer `cache`, ou o pacote deve importá-lo. O exemplo mostra a
semântica do agendamento, sem criar uma API global de cache.

O Lógos prepara todos os participantes antes de publicar, reverte em ordem inversa
se algo falhar e descarta a geração anterior após a nova publicação. O provedor
precisa implementar compensação de seus próprios efeitos e evitar que o descarte
da geração antiga remova a nova. `prepare` não deve publicar efeitos visíveis.

## Assinaturas e documentação de schema

```prisma
model User {
  # Identificador do Usuário
  ID Int @id
  name String # Nome do Usuário
}
```

```coffee
module tool = (resource) ->
  @tag {ParamDeclaration[]} [params]
  @tag {TypeExpression} returns
  @tag {string} [description]
  # Retorne prepare/commit/rollback/dispose para publicar resource.handler.
  prepararFerramenta resource

tool getUser = (ID: User.ID): User? ->
  @description "Busca um usuário"
  User[ID]

tool updateName = (ID: User.ID, newName: User.name): User ->
  @param newName - Nome escolhido nesta operação
  user = User[ID]
  throw new Error "Usuário não encontrado" unless user?
  user.name = newName
  user
```

`prepararFerramenta` é uma função fornecida pelo pacote do provedor. O compilador
não publica ferramentas por conta própria. No host Lógos, `User.ID` resolve para
`Int` e herda a descrição do campo. `@param nome - descrição` substitui a descrição
apenas naquela operação. `.schema` e `.scriba` usam o mesmo formato; `.prisma`
continua aceito pelo host por compatibilidade. Não é necessário declarar `type`
no schema. O suporte é ao formato Scriba, sem prometer toda a gramática Prisma.

Usar modelos como tipos não abre banco. `User[ID]` depende do módulo de persistência
e mantém a autorização e o escopo do pacote. O compilador sozinho não fornece ORM.

## API do compilador

```js
const { compileResource } = require('logostype');
const result = compileResource(source, { filename: '/packages/demo/index.type' });
// result.js: CommonJS com exports automáticos e source map inline
// result.docs: metadados normalizados por nome do handler
// result.declarations: kind, name, params, returns e linha original
```

## Capacidades sem import

O protocolo opcional [`logos-capabilities/v1`](docs/logos-capabilities-v1.md)
permite ao host fornecer eventos sem acoplar o compilador ao Runtime. A sintaxe
autoral é CoffeeScript comum, como `await identity.user.get 12`; `$` é apenas a
ponte interna do host.

Fluxo: fonte `.type` → assinatura e diretivas → CoffeeScript → JavaScript + declarações
→ host descobre provedores → valida contratos e tipos → prepara → publica.

A API `compile()` e as ferramentas `coffee`/`cake` continuam compilando CoffeeScript
convencional. Use `compileResource()` para a sintaxe LógosType. Os compiladores de
browser existentes continuam sendo os do CoffeeScript.

## Regras da primeira versão

- Declarações no topo do arquivo, com assinatura em uma única linha.
- Todo parâmetro de consumidor tem tipo; todo consumidor declara retorno.
- O argumento `resource` do provedor é o envelope do protocolo, sem anotação obrigatória.
- Provedores declaram contratos via `@tag`; o Lógos exige pelo menos uma tag.
- Diretivas são estáticas, contíguas no início do corpo, e não executam por chamada.
- Nessa posição, `@nome valor` é reservado aos metadados. Para acessar `this`, use `this.nome`.
- Nomes como `tool`, `router`, `task` não são capacidades embutidas. O host exige seus provedores.
- Assinaturas geram `@params` e `@returns`. Não repita essas diretivas no corpo.
- Metadados simples usam literais; `@tag {Tipo} nome` define o contrato do provedor.
- Funções registradas são exportadas automaticamente; auxiliares continuam locais.
- Blocos `###` com `@register` ou `# @register` e exports explícitos continuam aceitos.
- `void` descarta o retorno implícito do CoffeeScript, inclusive quando for Promise.
- Este PR não implementa `on`, `before`, `after` nem notificações automáticas de chamadas.

## Catálogo de recursos

`compileCatalog` recebe as fontes de um pacote e devolve um catálogo versionado.
Cada recurso inclui a identidade canônica, a assinatura e o arquivo e linha da
declaração. As chamadas registram a posição de uso e incluem a identidade do alvo
quando resolvidas no próprio pacote ou em um catálogo fornecido em
`externalCatalogs`. A lista `dependencies` reúne os pacotes externos referenciados
mesmo quando o catálogo deles ainda está indisponível.

O compilador verifica a quantidade de argumentos e incompatibilidades que
consegue demonstrar com literais nas chamadas de capacidade resolvidas. Também
verifica retornos literais e retornos diretos de chamadas de capacidade com
assinatura conhecida. Expressões de tipo desconhecido ficam para a execução.

```js
const { compileCatalog } = require('logostype');

const catalog = compileCatalog({
  package: 'agenda',
  sources: [
    { filename: 'read.type', source: 'query read = (id: number): number -> id' },
  ],
});

const completions = catalog.resources.map(({ identity, origin }) => ({
  label: identity,
  definition: origin,
}));
```

Para validar capacidades em execução, configure o host com um resolvedor de
catálogos. Ele verifica os argumentos antes de despachar e o retorno quando a
chamada termina. A versão do catálogo deve corresponder a
`RESOURCE_CATALOG_VERSION`. O host fornece `matchesType` para tipos de domínio,
como `User.ID`, e deve disponibilizar apenas catálogos da geração ativa
visíveis para o chamador. A autorização do despacho continua a cargo do host.

```js
const { createCapabilityHost } = require('logostype');

const $ = createCapabilityHost({
  package: 'agenda',
  dispatch,
  catalogForPackage: name => activeCatalogs.get(name),
  matchesType: (name, value) => name === 'User.ID' && Number.isInteger(value),
});
```

Com essa configuração, uma referência dinâmica é resolvida pelo catálogo em
execução. Catálogos ausentes ou incompatíveis, referências ambíguas e violações
de assinatura produzem `LOGOS_CONTRACT_MISMATCH`. O catálogo cobre as
declarações tipadas das fontes fornecidas a `compileCatalog`.

## Desenvolvimento

```bash
npm run test:logostype
npm test
```

O compilador CoffeeScript original, seus autores e sua licença MIT são preservados.
Veja [COFFEESCRIPT.md](COFFEESCRIPT.md) e [LICENSE](LICENSE).
