import * as oidc from "openid-client";
import type { Config } from "../config.js";

export interface IdentityProvider {
  issuer: string;
  redirectUri: string;
  authorization(input: { state: string; nonce: string; verifier: string }): Promise<string>;
  exchange(input: { code: string; state: string; nonce: string; verifier: string }): Promise<{ subject: string }>;
}

/** Provider-neutral OIDC authorization code flow. Never link accounts by email. */
export function identityProvider(config: Config): IdentityProvider | undefined {
  if (!config.OIDC_ISSUER) return;
  if (!config.OIDC_CLIENT_ID || !config.OIDC_CLIENT_SECRET || !config.OIDC_REDIRECT_URI) throw new Error("OIDC requires issuer, client ID, client secret and fixed redirect URI");
  const issuer = config.OIDC_ISSUER, redirectUri = config.OIDC_REDIRECT_URI;
  let cached: Promise<oidc.Configuration> | undefined;
  const client = () => cached ??= oidc.discovery(new URL(issuer), config.OIDC_CLIENT_ID!, config.OIDC_CLIENT_SECRET!, undefined, { timeout: 10 }).catch((e) => { cached = undefined; throw e; });
  return {
    issuer, redirectUri,
    async authorization({ state, nonce, verifier }) {
      return oidc.buildAuthorizationUrl(await client(), { redirect_uri: redirectUri, scope: "openid", response_type: "code", state, nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256" }).href;
    },
    async exchange({ code, state, nonce, verifier }) {
      const url = new URL(redirectUri); url.searchParams.set("code", code); url.searchParams.set("state", state);
      const tokens = await oidc.authorizationCodeGrant(await client(), url, { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true });
      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 500) throw new Error("OIDC subject missing");
      return { subject: claims.sub };
    },
  };
}
