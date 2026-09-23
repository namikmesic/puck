// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMd } from '../../src/renderer/markdown';

describe('renderMd', () => {
  it('renders GFM basics', () => {
    const html = renderMd('# Title\n\n**bold** and `code`\n\n- a\n- b');
    expect(html).toContain('<h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>a</li>');
  });

  it('renders fenced code blocks', () => {
    const html = renderMd('```bash\necho hi\n```');
    expect(html).toMatch(/<pre><code[^>]*>echo hi/);
  });

  it('strips script tags and event handlers', () => {
    const html = renderMd('hello <script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
  });

  it('neutralizes javascript: URLs', () => {
    const html = renderMd('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
  });

  it('forces safe targets on links', () => {
    const html = renderMd('[site](https://example.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
