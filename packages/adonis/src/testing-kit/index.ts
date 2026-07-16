/**
 * Barrel do subpath `@adonis-agora/durable/testing`: harness (`createTestEngine`), asserts,
 * replay determinístico e injeção de falhas -- nada aqui importa vitest, entao este subpath e
 * importavel por qualquer app, mesmo os que usam outro test runner (ex.: Japa). `vitest` e peer
 * dependency OPCIONAL do pacote justamente por isso.
 *
 * As suites de conformance (`runAdmissionBackendContract`, `runStateStoreContract`) GERAM casos
 * com `describe`/`it` do vitest e por isso exigem vitest de verdade -- ficam no subpath dedicado
 * `@adonis-agora/durable/testing/conformance`, para nao arrastar esse requisito para quem so
 * quer o harness.
 */
export * from './assertions.js';
export * from './harness.js';
export * from './replay.js';
export * from './steps.js';
export * from './transport-conformance.js';
