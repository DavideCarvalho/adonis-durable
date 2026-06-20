import { InMemoryStateStore } from '../../src/index.js';
import { runStateStoreContract } from '../../src/testing-kit/state-store-conformance.js';

// The in-memory store is the CANONICAL implementation of the StateStore contract — every SQL adapter
// must behave identically to it. Running the same shared suite against it here pins that reference
// behavior (lives in the testing package since core can't depend on testing).
runStateStoreContract('InMemoryStateStore', async () => ({
  store: new InMemoryStateStore(),
  cleanup: async () => undefined,
}));
