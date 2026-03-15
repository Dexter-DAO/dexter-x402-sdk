import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../browser-support';

describe('escapeHtml', () => {
  it('escapes all HTML-sensitive characters', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes script injection attempts', () => {
    const attack = '<script>alert("xss")</script>';
    const escaped = escapeHtml(attack);
    expect(escaped).not.toContain('<script');
    expect(escaped).not.toContain('</script');
    expect(escaped).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('escapes event handler injection', () => {
    const attack = '" onmouseover="alert(1)';
    const escaped = escapeHtml(attack);
    expect(escaped).not.toContain('"');
    expect(escaped).toBe('&quot; onmouseover=&quot;alert(1)');
  });

  it('escapes HTML entity injection', () => {
    const attack = '&lt;already-escaped&gt;';
    const escaped = escapeHtml(attack);
    // Double-escaping is correct — prevents entity decode attacks
    expect(escaped).toBe('&amp;lt;already-escaped&amp;gt;');
  });

  it('passes through safe strings unchanged', () => {
    expect(escapeHtml('Hello World')).toBe('Hello World');
    expect(escapeHtml('$0.01 USDC')).toBe('$0.01 USDC');
    expect(escapeHtml('api.example.com/data')).toBe('api.example.com/data');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('handles strings with mixed content', () => {
    const input = 'Pay $0.05 for "premium" data <beta>';
    const escaped = escapeHtml(input);
    expect(escaped).toBe('Pay $0.05 for &quot;premium&quot; data &lt;beta&gt;');
  });
});
