import { getDirname } from '@adonisjs/core/helpers';

/** Root of this package's publishable stubs (consumed by `configure`). */
export const stubsRoot = getDirname(import.meta.url);
