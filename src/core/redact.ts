/** Evidence is diagnostic metadata, never a credential export. */
export function redactText(text: string, values: string[] = []): string {
  let result = text;
  for (const value of [...new Set(values)].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length)) result = result.split(value).join("[REDACTED]");
  return result
    .replace(/("(?:password(?:hash)?|passwd|secret|clientSecret|apiKey|accessToken|refreshToken|privateKey|resetToken|authorization|cookie)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/\bBearer\s+(?!\$QA_TOKEN_)[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|access_token|key|password|secret)=)[^&#\s]*/gi, "$1[REDACTED]");
}

export function redactValue<T>(input: T, values: string[]): T {
  if (typeof input === "string") return redactText(input, values) as T;
  if (Array.isArray(input)) return input.map((v) => redactValue(v, values)) as T;
  if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, redactValue(v, values)])) as T;
  return input;
}
