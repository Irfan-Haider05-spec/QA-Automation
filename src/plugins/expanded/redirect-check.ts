import { z } from 'zod';
import type { BrowserContext } from 'playwright';
import { localPath } from './support.js';

export const redirectCaseSchema = z.object({
  app: z.string(), path: localPath, public: z.boolean().default(false),
  queryParam: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  safePath: localPath.refine(p => !p.includes('?') && !p.includes('#'), 'safePath must be a plain path'),
  rejectionStatuses: z.array(z.number().int()).min(1).max(3).default([400, 403, 422])
    .refine(v => v.every(n => [400, 403, 422].includes(n)), 'Use explicit policy rejection statuses'),
}).strict();

/** Follow only same-origin HTTP redirects. Never send a request to a probe host. */
export async function checkRedirects(context: BrowserContext, origin: string, c: z.output<typeof redirectCaseSchema>): Promise<boolean> {
  const follow = async (value: string) => {
    let url = new URL(c.path, origin);
    url.searchParams.set(c.queryParam, value);
    let hops = 0;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(url.href)) throw new Error('Redirect loop');
      seen.add(url.href);
      const response = await context.request.get(url.href, { maxRedirects: 0, maxRetries: 0, timeout: 10000 });
      const status = response.status(), location = response.headers().location;
      await response.dispose();
      if (![301, 302, 303, 307, 308].includes(status)) return { external: false, status, path: url.pathname, hops };
      if (!location || ++hops > 8) throw new Error('Missing redirect location or redirect limit exceeded');
      const next = new URL(location, url);
      if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password) throw new Error('Unsupported redirect destination');
      if (next.origin !== origin) return { external: true, status, path: '', hops };
      url = next;
    }
  };
  const control = await follow(c.safePath);
  if (control.external || !control.hops || control.path !== c.safePath || control.status < 200 || control.status >= 300) throw new Error('Same-origin redirect positive control failed');
  for (const payload of ['https://veriq-redirect.invalid/probe', '//veriq-redirect.invalid/probe']) {
    const result = await follow(payload);
    if (result.external) return true;
    if (!c.rejectionStatuses.includes(result.status) && !(result.status >= 200 && result.status < 300 && result.path === c.safePath)) throw new Error('Redirect rejection inconclusive');
  }
  return false;
}
