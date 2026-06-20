import { InMemoryAdmissionBackend } from '../../src/index.js';
import { runAdmissionBackendContract } from '../../src/testing-kit/admission-backend-conformance.js';

// The in-process backend is the CANONICAL implementation of the admission contract — the Redis
// backend must behave identically. Running the shared suite here pins that reference behavior (lives
// in the testing package since core can't depend on testing).
runAdmissionBackendContract(
  'InMemoryAdmissionBackend',
  (clock) => new InMemoryAdmissionBackend(clock),
);
