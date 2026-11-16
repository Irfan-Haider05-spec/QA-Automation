import type { Page } from 'playwright';

/** Injection contexts for XSS canaries; payloads only set a random page marker. */
export const XSS_CONTEXTS = ['html', 'attribute', 'script', 'url'] as const;
export type XssContext = typeof XSS_CONTEXTS[number];
export const XSS_TITLES: Record<XssContext, string> = {
  html: 'Query input executed browser script',
  attribute: 'Query input broke out of an HTML attribute and executed script',
  script: 'Query input broke out of a script string and executed',
  url: 'Query input became a javascript: URL in the page',
};
export function xssPayloads(context: XssContext, marker: string): string[] {
  const set = `window['${marker}']=true`;
  const img = `<img src="data:," onerror="${set}">`;
  if (context === 'html') return [img];
  // Quoted-attribute breakouts, an event attribute that needs no angle brackets, and an
  // unquoted-attribute breakout that needs neither quotes nor angle brackets.
  if (context === 'attribute') return [`">${img}`, `'>${img}`, `x" autofocus onfocus="${set}" x="`, `x autofocus onfocus=window.${marker}=true`];
  // Single, double and template-literal string breakouts, then closing the script element.
  if (context === 'script') return [`';${set};//`, `";${set};//`, `\${${set}}`, `</script>${img}`];
  // A javascript: URL; the tab variant defeats naive "starts with javascript:" filters.
  return [`javascript:top.${marker}=true`, `\tjavascript:top.${marker}=true`];
}

/**
 * True when the canary ran, or when a navigable attribute (href, src, action, formaction,
 * xlink:href) holds a javascript: URL carrying the marker. Such a URL runs script when
 * followed, which a passive probe deliberately does not do.
 */
export async function xssObserved(page: Page, marker: string): Promise<boolean> {
  return page.evaluate(key => {
    if ((window as unknown as Record<string, unknown>)[key] === true) return true;
    const elements = Array.from(document.querySelectorAll('[href],[src],[action],[formaction],[data]')).slice(0, 5000);
    for (const el of elements) {
      for (const name of ['href', 'src', 'action', 'formaction', 'data', 'xlink:href']) {
        const value = el.getAttribute(name);
        // URL parsers drop ASCII whitespace/control characters, so normalize the same way.
        if (value && value.replace(/[\u0000- ]/g, '').toLowerCase().startsWith('javascript:') && value.includes(key)) return true;
      }
    }
    return false;
  }, marker);
}
