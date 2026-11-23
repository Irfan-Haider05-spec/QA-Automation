import fs from "node:fs";
import { XMLParser, XMLValidator } from "fast-xml-parser";

/**
 * Safe JUnit XML reading shared by the test-results and flaky-tests checks.
 * DTD/entity declarations are refused (no entity expansion), size and nesting are
 * bounded, and captured output (system-out, failure text) is never returned, because
 * it can contain credentials.
 */

export const MAX_JUNIT_BYTES = 20 * 1024 * 1024;
const MAX_DEPTH = 50;

export type JUnitOutcome = "passed" | "failed" | "skipped";
export interface JUnitCase {
  /**
   * `classname name`, trimmed; the identity used in findings and history. Prefixed with
   * `suite › ` when the same name appears in more than one suite (Newman reports).
   */
  name: string;
  outcome: JUnitOutcome;
  /**
   * The report records a failed attempt before the final result: Surefire/Gradle
   * `flakyFailure`/`flakyError` (passed on a rerun) or `rerunFailure`/`rerunError`.
   */
  retried: boolean;
}

/**
 * Entity expansion is off (no DTD entities can exist: DOCTYPE is refused), so attribute
 * text arrives raw. Decode only XML's predefined entities and numeric character
 * references, so "doesn&apos;t" and "doesn&#39;t" both become "doesn't".
 */
export function decodeXmlText(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === "lt") return "<"; if (k === "gt") return ">"; if (k === "amp") return "&"; if (k === "quot") return '"'; if (k === "apos") return "'";
    const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : m;
  });
}

const array = (v: unknown): any[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const present = (t: any, ...keys: string[]) => keys.some((k) => t[k] !== undefined);

export function parseJUnit(text: string): JUnitCase[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("JUnit DTD/entity declarations are not allowed");
  if (XMLValidator.validate(text) !== true) throw new Error("Invalid JUnit XML");
  const doc = new XMLParser({ ignoreAttributes: false, processEntities: false, parseAttributeValue: false }).parse(text);
  const cases: (JUnitCase & { suite: string })[] = [];
  const walk = (suite: any, depth: number, parentName: string) => {
    if (depth > MAX_DEPTH) throw new Error("JUnit nesting too deep");
    if (!suite || typeof suite !== "object") return;
    const suiteName = decodeXmlText(String(suite["@_name"] ?? "")).replace(/\s+/g, " ").trim() || parentName;
    for (const t of array(suite.testcase)) {
      const tc = t && typeof t === "object" ? t : {};
      const name = decodeXmlText(`${tc["@_classname"] ?? ""} ${tc["@_name"] ?? "unnamed"}`).replace(/\s+/g, " ").trim();
      const outcome: JUnitOutcome = present(tc, "failure", "error") ? "failed" : present(tc, "skipped") ? "skipped" : "passed";
      cases.push({ name, outcome, retried: present(tc, "flakyFailure", "flakyError", "rerunFailure", "rerunError"), suite: suiteName });
    }
    for (const child of array(suite.testsuite)) walk(child, depth + 1, suiteName);
  };
  if (doc.testsuites) walk(doc.testsuites, 0, "");
  else for (const suite of array(doc.testsuite)) walk(suite, 0, "");
  // Newman (Postman) and similar reporters name assertions the same in every request
  // ("Status code is 200"), one request per suite. When one name appears in different
  // suites, the suite name tells the tests apart; without it they would merge, and one
  // passing and one failing request would look like a flaky test. Repeats inside one suite
  // keep their name: some reporters record reruns that way. Unique names never change.
  const suites = new Map<string, Set<string>>();
  for (const c of cases) (suites.get(c.name) ?? suites.set(c.name, new Set()).get(c.name)!).add(c.suite);
  return cases.map(({ suite, ...c }) => (suite && suites.get(c.name)!.size > 1 ? { ...c, name: `${suite} › ${c.name}` } : c));
}

export function readJUnitFile(file: string): JUnitCase[] {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`JUnit report ${file} not found`);
  if (stat.size > MAX_JUNIT_BYTES) throw new Error("JUnit report exceeds 20 MiB");
  return parseJUnit(fs.readFileSync(file, "utf8"));
}
