import { isDeepStrictEqual } from 'node:util';
import { resolveRef } from '../../discovery/import.js';

export function validateComparisonSchema(schema: any): void {
  if (schema === undefined) return;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Contract comparison requires object schemas');
  if (['allOf', 'oneOf', 'anyOf', 'not', 'if', 'then', 'else', 'dependentSchemas', 'unevaluatedProperties', 'prefixItems'].some(k => k in schema)) throw new Error('Contract composition requires a bundled/flattened comparison schema');
}

export function typesIncluded(from: any, to: any): boolean {
  const types = (s: any): string[] | undefined => {
    if (!s?.type) return undefined;
    const values = Array.isArray(s.type) ? s.type : [s.type];
    if (!values.every((v: unknown) => typeof v === 'string' && ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(v))) throw new Error('Unsupported contract type');
    return [...new Set<string>([...values, ...(s.nullable ? ['null'] : [])])];
  };
  const a = types(from), b = types(to);
  if (!b) return true;
  if (!a) return false;
  return a.every(v => b.includes(v) || (v === 'integer' && b.includes('number')));
}

/** Direction matters: requests must not narrow, responses must not widen.
 * Deliberately bounded subset, not a general JSON Schema subsumption solver. */
export function inputRestrictions(baseDoc: any, headDoc: any, before: any, after: any, prefix: string, depth = 0): string[] {
  if (depth > 25) throw new Error('Contract schema recursion limit exceeded');
  const old = resolveRef(baseDoc, before), next = resolveRef(headDoc, after);
  validateComparisonSchema(old); validateComparisonSchema(next);
  if (!next) return [];
  for (const schema of [old, next]) if (schema && ['allOf', 'oneOf', 'anyOf'].some(k => k in schema)) throw new Error('Contract composition requires a bundled/flattened comparison schema');
  const changes: string[] = [];
  if (!typesIncluded(old, next)) changes.push(`${prefix} (input type narrowed)`);
  if (next.enum && (!old?.enum || old.enum.some((v: unknown) => !next.enum.some((n: unknown) => isDeepStrictEqual(n, v))))) changes.push(`${prefix} (input enum narrowed)`);
  for (const name of next.required ?? []) if (!(old?.required ?? []).includes(name)) changes.push(`${prefix}.${name} (new required property)`);
  for (const key of ['minimum', 'minLength', 'minItems', 'minProperties']) if (typeof next[key] === 'number' && (typeof old?.[key] !== 'number' || next[key] > old[key])) changes.push(`${prefix} (${key} increased)`);
  for (const key of ['maximum', 'maxLength', 'maxItems', 'maxProperties']) if (typeof next[key] === 'number' && (typeof old?.[key] !== 'number' || next[key] < old[key])) changes.push(`${prefix} (${key} decreased)`);
  for (const key of ['pattern', 'format']) if (next[key] && next[key] !== old?.[key]) changes.push(`${prefix} (${key} restriction changed)`);
  if (next.additionalProperties === false && old?.additionalProperties !== false) changes.push(`${prefix} (additional properties disallowed)`);
  for (const [name, schema] of Object.entries(next.properties ?? {})) {
    if (old?.properties?.[name] !== undefined || old?.additionalProperties !== false) {
      const prior = old?.properties?.[name] ?? (typeof old?.additionalProperties === 'object' ? old.additionalProperties : undefined);
      changes.push(...inputRestrictions(baseDoc, headDoc, prior, schema, `${prefix}.${name}`, depth + 1));
    }
  }
  for (const [name] of Object.entries(old?.properties ?? {})) {
    if (!next.properties?.[name] && next.additionalProperties === false) changes.push(`${prefix}.${name} (input property rejected)`);
  }
  if (next.items) changes.push(...inputRestrictions(baseDoc, headDoc, old?.items, next.items, `${prefix}[]`, depth + 1));
  return changes;
}

export function responseGuarantees(old: any, next: any, prefix: string): string[] {
  const changes: string[] = [];
  if (next.nullable === true && old.nullable !== true) changes.push(`${prefix} (response may now be null)`);
  if (old.enum && (!next.enum || next.enum.some((v: unknown) => !old.enum.some((o: unknown) => isDeepStrictEqual(o, v))))) changes.push(`${prefix} (response enum widened)`);
  for (const name of old.required ?? []) if (!(next.required ?? []).includes(name)) changes.push(`${prefix}.${name} (response no longer guaranteed)`);
  return changes;
}
