---
"@adonis-agora/durable": patch
---

Corrige problemas de robustez no engine e no bootstrap:

- **Efeitos pós-settle agora são aguardados pelo `drain()`.** Depois que um run era persistido no
  estado terminal, `settleRun` disparava `notifyParent` (que pode acordar e retomar um run PAI
  suspenso) e o `execute`/`cancel` disparavam o `wakeNext` do singleton — ambos fire-and-forget, fora
  do conjunto `inflight`. O `drain()` só esperava o `inflight`, então essas escritas no store
  escapavam da drenagem: em apps que rodam testes sob uma transação global do Lucid, o `updateRun` do
  pai/singleton disparava após o rollback, virando um unhandled rejection ("Transaction query already
  complete") depois da suíte passar — CI vermelho com testes verdes. Esses efeitos agora entram num
  registry `postSettle` que o `drain()` aguarda junto com o `inflight` (em laço, pois um efeito pode
  retomar outro run), sem que o caminho do `execute()` passe a bloquear neles — o retorno ao chamador
  continua imediato ao persistir o status.

- **Mais três efeitos fire-and-forget internos passam a ser aguardados pelo `drain()`.** Eram da mesma
  classe do `notifyParent`/`wakeNext` — `queueMicrotask(...)` sem tracking, com escrita no store,
  disparados de dentro de um run que settla/cancela — e pré-existiam desde antes deste PR, expondo
  consumidores de cancelamento de child, entidades duráveis e compensação saga ao mesmo
  "Transaction query already complete" pós-teardown que este PR combate:
  - **`ctx.cancelChild`** (usado pelo `ctx.all` failFast p/ cancelar os irmãos sobreviventes): o
    `cancel()` — que escreve o filho e toda a cascata de cancelamento no store — agora entra no
    `postSettle` (defer de reentrância preservado, promise registrada de forma síncrona).
  - **`ctx.signalEntity`** (entidades duráveis): o `entities.dispatch` persiste via `signalWithStart`
    (createRun/signal do run da entidade), então a op passa a ser aguardada pelo `drain()`.
  - **Resume da compensação no cancel-compensate** (`engine.cancel({ compensate: true })`): o resume em
    background que replaya o run e roda as compensações até o `cancelled` terminal era um
    `queueMicrotask` não-rastreado, e o `resume()` só entra no `inflight` quando de fato é chamado (um
    microtask depois) — então o `drain()` podia ver os dois registries vazios nessa janela pré-`inflight`
    e retornar antes das escritas de compensação. Agora o resume deferido é segurado no `postSettle`
    (não é um `handoffRun`: aqui um run EXISTENTE é retomado, e sua execução já se auto-rastreia no
    `inflight` — só a janela antes da chamada precisava ser coberta).

- **Os handoffs internos de run (`continue-as-new` e child deferido) também são aguardados pelo
  `drain()`.** Antes, ambos entravam por um `queueMicrotask(() => void this.start(...))` fire-and-forget:
  entre o settle do pai e o novo run entrar no `inflight` havia hops de microtask + I/O de store, e essa
  ponte ficava fora dos dois registries. O `drain()` podia observar `inflight` e `postSettle` vazios
  nessa janela e retornar cedo, deixando a persistência (`createRun`) e o processamento do run
  continuado/filho escaparem — o mesmo hazard "Transaction query already complete" pós-rollback, agora
  para quem usa continue-as-new/child workflows. Agora cada handoff é registrado no `postSettle` de
  forma síncrona no settle do pai (via `handoffRun`), preservando o defer de reentrância; com o
  dispatcher in-process padrão ele mesmo conduz o pickup (`leaseAndResume`, sem o guard de `draining`,
  pois é trabalho já em voo que o `drain()` aguarda), então a promise só resolve quando o run entrou no
  `inflight` e settlou. O run fica brevemente nos DOIS conjuntos, o que é inofensivo porque o laço do
  `drain()` re-snapshota ambos a cada iteração.

- **`whenBootedApp()` agora falha com mensagem clara em vez de pendurar pra sempre.** O top-level
  `const app = await whenBootedApp()` do `services/main` ficava pendente SILENCIOSAMENTE se o
  `DurableProvider` não estivesse registrado nos providers — DX pior que um erro explícito. Agora um
  timeout (padrão 5s) rejeita com uma mensagem acionável apontando pra adicionar
  `"@adonis-agora/durable/durable_provider"` no `adonisrc.ts`. O caminho normal não é afetado: o
  provider registra antes do await, então o fast path devolve uma promise já resolvida (sem timer
  armado); mesmo quando um timer é armado ele é limpo — e `unref`'d — assim que o app chega.

- **`services/main` não captura mais o singleton `app` do core de forma eager.** O
  `import app from '@adonisjs/core/services/app'` no topo do módulo é o mesmo dual-package hazard que
  já quebrou produção com o `@adonisjs/lucid`: com duas cópias físicas de `@adonisjs/core` na árvore
  (pnpm/hoist), a cópia importada pode não ser a que o `bin/server` bootou, deixando o `app` como
  `undefined`. Agora o `DurableProvider` alimenta a instância booted que RECEBE no `register()` para
  um módulo `services/booted_app`, e o `services/main` lê dali — imune ao split de cópias. O
  comportamento observável para os consumidores atuais (`import engine`, `import { runGateway }`) é
  idêntico.
