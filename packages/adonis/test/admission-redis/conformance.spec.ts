import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe } from 'vitest';
import { RedisAdmissionBackend } from '../../src/admission-redis/index.js';
import { runAdmissionBackendContract } from '../../src/testing-kit/index.js';

/**
 * Run the shared cross-backend admission contract against a REAL Redis (set REDIS_URL), so the Redis
 * backend's concurrency / rate / priority / FIFO / LIFO / fairness semantics are pinned identical to
 * the canonical in-process reference. Self-skips without REDIS_URL. Each backend gets a fresh key
 * prefix so successive cases don't collide, and all are closed (heartbeats stopped) afterwards.
 */
const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)('RedisAdmissionBackend conformance', () => {
  let redis: Redis;
  const created: RedisAdmissionBackend[] = [];
  let n = 0;

  beforeAll(() => {
    redis = new Redis(REDIS_URL as string);
  });
  afterAll(async () => {
    for (const b of created) await b.close();
    await redis.flushall();
    redis.disconnect();
  });

  runAdmissionBackendContract('RedisAdmissionBackend', (clock) => {
    const backend = new RedisAdmissionBackend({ connection: redis, clock, prefix: `conf${++n}` });
    created.push(backend);
    return backend;
  });
});
