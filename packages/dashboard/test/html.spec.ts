import { describe, expect, it } from 'vitest';
import { renderDashboard } from '../src/html.js';

describe('renderDashboard', () => {
  it('serves a self-contained HTML document', () => {
    const html = renderDashboard('/durable/api');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>Durable');
    // Inline CSS + JS, no external build assets.
    expect(html).toContain('<style>');
    expect(html).toContain('<script>');
    expect(html).not.toContain('<link rel="stylesheet"');
  });

  it('injects the API base path the client fetches from', () => {
    const html = renderDashboard('/admin/durable/api');
    expect(html).toContain("const API_BASE = '/admin/durable/api'");
    // The placeholder must be fully substituted.
    expect(html).not.toContain('__API_BASE__');
  });

  it('references the runs + health API endpoints', () => {
    const html = renderDashboard('/durable/api');
    expect(html).toContain("api('/runs");
    expect(html).toContain("api('/health')");
  });
});
