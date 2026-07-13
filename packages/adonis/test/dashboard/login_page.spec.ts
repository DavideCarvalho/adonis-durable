import { describe, expect, it } from 'vitest';
import { renderLoginPage } from '../../src/dashboard/login_page.js';

describe('renderLoginPage', () => {
  const html = renderLoginPage('/durable');

  it('keeps the "Sign in — Durable" title', () => {
    expect(html).toContain('<title>Sign in — Durable</title>');
  });

  it('requires username but leaves password optional (no HTML `required`)', () => {
    const usernameInput = html.match(/<input id="username"[^>]*>/)?.[0];
    const passwordInput = html.match(/<input id="password"[^>]*>/)?.[0];
    expect(usernameInput).toContain('required');
    expect(passwordInput).toBeDefined();
    expect(passwordInput).not.toContain('required');
  });

  it('mirrors the dark zinc / emerald palette', () => {
    expect(html).toContain('#09090b');
    expect(html).toContain('#18181b');
    expect(html).toContain('#34d399');
    expect(html).toContain('ui-monospace');
  });

  it('posts to `<basePath>/login`', () => {
    expect(html).toContain('"/durable/login"');
  });

  it('embeds basePath via JSON so a quote in it cannot break out of the script', () => {
    // basePath is developer-controlled config, but it is still injected through JSON.stringify so a
    // stray quote is escaped rather than closing the string literal / injecting script.
    const injected = renderLoginPage('/dur"able');
    expect(injected).toContain(JSON.stringify('/dur"able/login'));
    expect(injected).not.toContain('"/dur"able/login"');
  });
});
