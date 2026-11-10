/**
 * Accessibility (WCAG 2 A/AA) with axe-core on every crawled page.
 * One finding per rule per app, listing the pages it appears on, so a shared
 * layout problem shows up once instead of once per page.
 * Severities are kept low (critical → medium) so a11y debt doesn't block
 * merges until the team decides it should.
 */
import type { Finding, QaPlugin, Severity } from "../core/types.js";
import { getCrawl } from "../web/crawler.js";

const SEV: Record<string, Severity> = { critical: "medium", serious: "low", moderate: "info", minor: "info" };

export const webA11yPlugin: QaPlugin = {
  name: "web-a11y",
  layer: "web",
  description: "axe-core WCAG 2 A/AA scan of every crawled dashboard page",
  needs: ["webApps"],
  async run(ctx) {
    const findings: Finding[] = [];
    let scanned = 0;
    for (const app of ctx.config.web.apps.filter((a) => a.baseUrl)) {
      const c = await getCrawl(ctx, app);
      const byRule = new Map<string, { v: NonNullable<(typeof c.pages)[number]["axe"]>[number]; pages: string[] }>();
      for (const p of c.pages) {
        if (!p.axe) continue;
        scanned++;
        for (const v of p.axe) {
          const e = byRule.get(v.id) ?? { v, pages: [] };
          e.pages.push(p.template);
          byRule.set(v.id, e);
        }
      }
      for (const [id, { v, pages }] of byRule) {
        findings.push({
          plugin: this.name, severity: SEV[v.impact ?? "minor"] ?? "info", category: "quality", target: `${app.name} a11y:${id}`,
          title: `${v.help} (${v.impact ?? "minor"})`,
          detail: `On ${pages.length} page(s): ${pages.slice(0, 8).join(", ")}${pages.length > 8 ? " …" : ""}\nExample elements: ${v.nodes.join(" | ")}\nHow to fix: ${v.helpUrl}`,
        });
      }
    }
    return { findings, stats: { pagesScanned: scanned } };
  },
};
