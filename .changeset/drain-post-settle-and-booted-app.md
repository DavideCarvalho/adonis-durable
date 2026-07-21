---
"@adonis-agora/durable": patch
---

Corrige dois problemas de robustez no engine e no bootstrap:

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

- **`services/main` não captura mais o singleton `app` do core de forma eager.** O
  `import app from '@adonisjs/core/services/app'` no topo do módulo é o mesmo dual-package hazard que
  já quebrou produção com o `@adonisjs/lucid`: com duas cópias físicas de `@adonisjs/core` na árvore
  (pnpm/hoist), a cópia importada pode não ser a que o `bin/server` bootou, deixando o `app` como
  `undefined`. Agora o `DurableProvider` alimenta a instância booted que RECEBE no `register()` para
  um módulo `services/booted_app`, e o `services/main` lê dali — imune ao split de cópias. O
  comportamento observável para os consumidores atuais (`import engine`, `import { runGateway }`) é
  idêntico.
