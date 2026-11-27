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
não publica ferramentas por conta própria. O exemplo usa `User.ID` para
referir-se ao campo `ID` do modelo `User`, declarado como `Int`. A validação
dinâmica de tipos de domínio usa o callback `matchesType` fornecido pelo host.

| Componente | `.schema` | `.scriba` | `.prisma` |
| --- | --- | --- | --- |
| LogosType | Texto fornecido ao compilador | Texto fornecido ao compilador | Texto fornecido ao compilador |
| Compositor do Lógos | Fora da descoberta | Fragmento descoberto | Fonte principal ou fragmento descoberto |
| Parser do Scriba | Sem descoberta por extensão | Sem descoberta por extensão | Lê o conteúdo do caminho fornecido pelo host, normalmente o schema composto |

O compositor dá prioridade a `schema.prisma` na raiz sobre campos
conflitantes de fragmentos. Para manter essa precedência, passe o resultado de
`composePackageSchema` ao compilador como
`schemas: [{ filename: composed.outputPath, source: composed.schema }]`.
A descoberta automática de `.schema` pelo Lógos continua proposta. As três
extensões usam a mesma sintaxe de declarações compatível com Prisma no
LogosType. O Scriba interpreta o subconjunto aceito pelo seu parser.

`createSchemaCatalog([{ filename, source }])` retorna metadados versionados
de modelos, campos, cardinalidade, descrições `///` presentes no texto e chaves
primárias e únicas, inclusive compostas. Fontes diretas com modelos repetidos
geram diagnóstico de conflito. O compositor deve receber primeiro os fragmentos
que precisam ser mesclados.

`compileCatalog` aceita a mesma lista opcional em `schemas`. Assim,
`User.ID` resolve o campo `ID` de `User`. O catálogo preserva a anotação
original e publica o tipo resolvido para validar argumentos e retornos. Escalares
como `Int` usam os tipos JavaScript existentes no compilador (`number` para
`Int`), e tipos de domínio sem mapeamento continuam a cargo de `matchesType`.
A resolução recebe apenas texto e opera sem conexão com banco. O acesso a
registros com `User[ID]` depende da persistência e da autorização do host.

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

### Named capability arguments

Use `named { ... }` to select arguments by the target signature rather than by
position.

```coffee
result = await identity.query.get named {id: 12, label: "owner"}
```

The capability host resolves the active target catalog and orders fields by the
target's declaration. A missing field with a declared default is passed as
`undefined`, allowing the provider to apply its default. Explicitly nullable
returns can include `null` or `undefined`. The catalog checks known fields and
literal types at the call's source location. Dynamic values require runtime
validation before dispatch.

The named object contains functional arguments only. The capability host
supplies the caller independently. The dispatcher owns authorization,
cancellation and tracing.
