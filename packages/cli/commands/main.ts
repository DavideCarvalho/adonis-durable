import { ListLoader } from '@adonisjs/core/ace';
import DurableRetry from './retry.js';
import DurableRuns from './runs.js';
import DurableWork from './work.js';

/**
 * The commands barrel for `@agora/durable-cli`. Registered in an app's `adonisrc` via
 * `rcFile.addCommand('@agora/durable-cli/commands')` (done by this package's `configure`). The ace
 * kernel imports this module and treats it as a commands loader: a {@link ListLoader} over the three
 * durable commands provides their metadata and constructors.
 */
const loader = new ListLoader([DurableWork, DurableRuns, DurableRetry]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
