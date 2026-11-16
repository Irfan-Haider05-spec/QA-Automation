import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { getPath } from '../../core/http.js';
import type { RunContext } from '../../core/context.js';
import type { Finding } from '../../core/types.js';
import { issue, request, requestSchema } from './support.js';

export const webhookStateSchema = z.object({
  verify: requestSchema,
  valuePath: z.string().regex(/^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*){0,10}$/),
  validSignatureEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  expectedValue: z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]),
  observeMs: z.number().int().min(50).max(5000).default(500),
  pollIntervalMs: z.number().int().min(25).max(1000).default(100),
}).strict().refine(c => c.verify.method === 'GET', 'Webhook state verification must be GET-only');
type StateConfig = z.output<typeof webhookStateSchema>;
const ok = (n: number) => n >= 200 && n < 300;

export async function verifyWebhookState(ctx: RunContext, spec: z.output<typeof requestSchema> & { signatureHeader: string }, c: StateConfig,
  variants: Array<[string, string | undefined]>, validSignature: string): Promise<Finding[]> {
  const read = async () => {
    const res = await request(ctx, c.verify);
    if (!ok(res.status)) throw new Error('Webhook state positive control cannot be read');
    const value = getPath(res.json, c.valuePath);
    if (value === undefined || (value !== null && !['string', 'number', 'boolean'].includes(typeof value))) throw new Error('Webhook state valuePath must resolve to a primitive or null');
    return value;
  };
  const initial = await read();
  if (initial === c.expectedValue) throw new Error('Webhook positive-control state already matches expectedValue; provision fresh test data');
  const findings: Finding[] = [];
  for (const [label, signature] of variants) {
    if (await read() !== initial) throw new Error('Webhook state changed before the probe; use isolated test data');
    const res = await request(ctx, spec, { headers: signature ? { [spec.signatureHeader]: signature } : {} });
    if (!ok(res.status) && ![400, 401, 403].includes(res.status)) throw new Error(`Webhook response inconclusive (HTTP ${res.status})`);
    const deadline = Date.now() + c.observeMs;
    for (;;) {
      if (await read() !== initial) {
        findings.push(issue('webhook-security', `Webhook processed ${label} signature`, spec.path,
          'The configured protected state changed during the observation window. State values and signatures are omitted.', 'high', 'security', 'CWE-345'));
        return findings; // Do not compound an observed unauthorized mutation.
      }
      if (Date.now() >= deadline) break;
      await delay(Math.min(c.pollIntervalMs, deadline - Date.now()));
    }
  }
  const positive = await request(ctx, spec, { headers: { [spec.signatureHeader]: validSignature } });
  if (!ok(positive.status)) throw new Error('Webhook valid-signature positive control was rejected');
  const deadline = Date.now() + c.observeMs;
  for (;;) {
    const actual = await read();
    if (actual === c.expectedValue) return findings;
    if (actual !== initial) throw new Error('Webhook positive control changed state unexpectedly');
    if (Date.now() >= deadline) throw new Error('Webhook positive control had no expected effect within the observation window');
    await delay(Math.min(c.pollIntervalMs, deadline - Date.now()));
  }
}
