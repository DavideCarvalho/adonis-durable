import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The dashboard HTML, loaded once from the bundled asset. The build copies
 * `assets/dashboard.html` into `dist/assets/`, so this resolves relative to the
 * compiled `dist/src/html.js`.
 */
let template: string | undefined;

function load(): string {
  if (template === undefined) {
    const assetUrl = new URL('../assets/dashboard.html', import.meta.url);
    template = readFileSync(fileURLToPath(assetUrl), 'utf8');
  }
  return template;
}

/**
 * Render the dashboard HTML with the JSON API base path injected, so the
 * single-page client knows where to fetch from regardless of the configured
 * mount prefix.
 */
export function renderDashboard(apiBase: string): string {
  return load().replaceAll('__API_BASE__', apiBase);
}
