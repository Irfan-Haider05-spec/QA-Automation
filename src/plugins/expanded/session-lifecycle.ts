import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RunContext } from '../../core/context.js';
import type { Finding } from '../../core/types.js';
import { getPath } from '../../core/http.js';
import { issue, localPath, request } from './support.js';

const field = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const responsePath = z.string().max(256).regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,10}$/);
export const refreshSessionSchema = z.object({
  path: localPath,
  refreshTokenPath: responsePath,
  accessTokenPath: responsePath.optional(),
  requestField: field.default('refreshToken'),
  rejectionStatuses: z.array(z.union([z.literal(400), z.literal(401), z.literal(403)])).min(1).max(3).default([401, 403]),
  reusePolicy: z.enum(['reject-only', 'revoke-family']),
  revokeAccessOnReuse: z.boolean().default(false),
  logoutPath: localPath.optional(),
  logoutRequestField: field.optional(),
  revokeAccessOnLogout: z.boolean().default(false),
}).strict().refine(c => !c.revokeAccessOnReuse || c.reusePolicy === 'revoke-family', 'Access revocation on reuse requires revoke-family policy')
  .refine(c => !!c.logoutPath || (!c.revokeAccessOnLogout && !c.logoutRequestField), 'Logout options require logoutPath');
type RefreshConfig = z.output<typeof refreshSessionSchema>;

export function validateRefreshSession(ctx: RunContext, account: string) {
  const login = ctx.config.login;
  if ((login.strategy ?? 'bearer') !== 'bearer' || login.otp) throw new Error('Refresh lifecycle currently requires a password-based bearer login without OTP');
  localPath.parse(login.path);
  const a = ctx.config.accounts[account];
  if (!a?.identifier || !a.password) throw new Error('Refresh lifecycle requires a dedicated QA account with login credentials');
  const template = login.bodyTemplate ?? { identifier: '{{identifier}}', password: '{{password}}', device: '{{device}}' };
  for (const value of Object.values(template)) if (/\{\{(?!identifier\}\}|password\}\}|device\}\})/.test(value)) throw new Error('Unsupported login template placeholder for refresh lifecycle');
}

/** Explicit policy checks, with fresh isolated sessions and no token-bearing evidence. */
export async function testRefreshSession(ctx: RunContext, account: string, protectedPath: string, c: RefreshConfig): Promise<Finding[]> {
  validateRefreshSession(ctx, account);
  const findings: Finding[] = [];
  const accepted = (status: number) => status >= 200 && status < 300;
  const bad = (title: string, target = c.path, severity: 'high' | 'medium' = 'high') => findings.push(issue('auth-session', title, target,
    'Observed behavior differs from the explicitly configured session policy. Tokens and response bodies are omitted.', severity, 'security', 'CWE-613'));
  const pair = (body: unknown) => {
    const access = getPath(body, c.accessTokenPath ?? ctx.config.login.tokenPath);
    const refresh = getPath(body, c.refreshTokenPath);
    if (![access, refresh].every(v => typeof v === 'string' && v.length > 0 && v.length <= 8192 && !/[\r\n]/.test(v))) throw new Error('Session response lacks valid configured access/refresh token fields');
    return { access: access as string, refresh: refresh as string };
  };
  const login = async () => {
    const a = ctx.config.accounts[account];
    const values: Record<string, string> = { identifier: a.identifier!, password: a.password!, device: a.device };
    const template = ctx.config.login.bodyTemplate ?? { identifier: '{{identifier}}', password: '{{password}}', device: '{{device}}' };
    const body = Object.fromEntries(Object.entries(template).map(([k, v]) => [k, v.replace(/\{\{(identifier|password|device)\}\}/g, (_, name) => values[name])]));
    const result = await request(ctx, { method: 'POST', path: ctx.config.login.path, json: body });
    if (!accepted(result.status)) throw new Error(`Fresh session login failed (HTTP ${result.status})`);
    return pair(result.json);
  };
  const access = (token: string) => request(ctx, { method: 'GET', path: protectedPath }, { headers: { authorization: `Bearer ${token}` } });
  const refresh = (token: string) => request(ctx, { method: 'POST', path: c.path, json: { [c.requestField]: token } });
  const control = async (token: string) => { if (!accepted((await access(token)).status)) throw new Error('Fresh access-token positive control failed'); };
  const reject = (status: number, title: string, target?: string, statuses: readonly number[] = c.rejectionStatuses) => {
    if (accepted(status)) bad(title, target);
    else if (!statuses.includes(status)) throw new Error(`Session rejection inconclusive (HTTP ${status})`);
  };

  const anonymous = await request(ctx, { method: 'GET', path: protectedPath });
  if (accepted(anonymous.status)) { bad('Protected session endpoint accepts anonymous requests', protectedPath); return findings; }
  if (![401, 403].includes(anonymous.status)) throw new Error('Protected-path anonymous control is inconclusive');
  const first = await login(); await control(first.access);
  const forged = await refresh(`veriq-invalid-${randomUUID()}`);
  reject(forged.status, 'Invalid refresh token accepted');
  const rotatedResponse = await refresh(first.refresh);
  if (!accepted(rotatedResponse.status)) throw new Error(`Refresh rotation failed (HTTP ${rotatedResponse.status})`);
  const rotated = pair(rotatedResponse.json); await control(rotated.access);
  if (rotated.refresh === first.refresh) {
    bad('Refresh token was not rotated');
    // Replaying the same still-current token would not test reuse correctly.
  } else {
    const replay = await refresh(first.refresh);
    reject(replay.status, 'Previously consumed refresh token accepted');
    if (!accepted(replay.status)) {
      if (c.reusePolicy === 'revoke-family') {
        // Inspect access revocation before a broken refresh endpoint can rotate
        // the family again and invalidate this token as an unrelated side effect.
        if (c.revokeAccessOnReuse) reject((await access(rotated.access)).status, 'Access token remains usable after reuse revocation', protectedPath, [401, 403]);
        const family = await refresh(rotated.refresh);
        reject(family.status, 'Refresh token family remains usable after reuse');
      } else {
        const next = await refresh(rotated.refresh);
        if (accepted(next.status)) await control(pair(next.json).access);
        else if (c.rejectionStatuses.includes(next.status as 400 | 401 | 403)) bad('Valid refresh token revoked despite reject-only reuse policy', c.path, 'medium');
        else throw new Error(`Session continuity inconclusive (HTTP ${next.status})`);
      }
    }
  }
  if (c.logoutPath) {
    // Reuse probes may revoke the earlier family; logout requires its own positive control.
    const fresh = await login(); await control(fresh.access);
    const logout = await request(ctx, { method: 'POST', path: c.logoutPath, json: { [c.logoutRequestField ?? c.requestField]: fresh.refresh } }, { headers: { authorization: `Bearer ${fresh.access}` } });
    if (!accepted(logout.status)) throw new Error(`Session logout failed (HTTP ${logout.status})`);
    if (c.revokeAccessOnLogout) reject((await access(fresh.access)).status, 'Access token remains usable after logout', protectedPath, [401, 403]);
    reject((await refresh(fresh.refresh)).status, 'Refresh token remains usable after logout', c.logoutPath);
  }
  return findings;
}
