import { fileURLToPath } from 'node:url';

/** Absolute path to the published stubs directory (`dist/stubs/main.js`). */
export const stubsRoot = fileURLToPath(new URL('./', import.meta.url));
