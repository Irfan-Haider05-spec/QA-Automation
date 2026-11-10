/**
 * Visual regression: compares each crawled page's screenshot with an approved
 * baseline (pixelmatch). Run with --update-visual to (re)write baselines.
 * Baselines must be made in the same environment CI uses (same OS, fonts,
 * browser), and live data areas (dates, counters, charts) should be masked
 * with web.visual.mask selectors.
 */
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type { Finding, QaPlugin } from "../core/types.js";
import { getCrawl, slugOf } from "../web/crawler.js";

export const webVisualPlugin: QaPlugin = {
  name: "web-visual",
  layer: "web",
  description: "Screenshot diff of every crawled page against approved baselines",
  needs: ["webApps"],
  async run(ctx) {
    const v = ctx.config.web.visual;
    const findings: Finding[] = [];
    const tally = { compared: 0, changed: 0, newBaselines: 0, written: 0 };
    for (const app of ctx.config.web.apps.filter((a) => a.baseUrl)) {
      const c = await getCrawl(ctx, app);
      const baseDir = path.resolve(ctx.configDir, v.baselineDir, app.name);
      const diffDir = path.join(ctx.outDir, "web", app.name, "diff");
      fs.mkdirSync(diffDir, { recursive: true });
      for (const p of c.pages) {
        if (!p.screenshot) continue;
        const current = path.join(ctx.outDir, p.screenshot);
        const baseline = path.join(baseDir, `${slugOf(p.template)}.png`);
        const target = `${app.name} ${p.template}`;
        if (ctx.updateVisual) {
          fs.mkdirSync(baseDir, { recursive: true });
          fs.copyFileSync(current, baseline);
          tally.written++;
          continue;
        }
        if (!fs.existsSync(baseline)) {
          tally.newBaselines++;
          findings.push({ plugin: this.name, severity: "info", category: "quality", target, title: "No visual baseline yet for this page", detail: "Approve the current look with: qa run --only web-crawl,web-visual --update-visual", evidence: { url: p.url, image: p.screenshot } });
          continue;
        }
        tally.compared++;
        const a = PNG.sync.read(fs.readFileSync(baseline));
        const b = PNG.sync.read(fs.readFileSync(current));
        if (a.width !== b.width || a.height !== b.height) {
          tally.changed++;
          findings.push({ plugin: this.name, severity: "medium", category: "regression", target, title: `Page size changed: ${a.width}×${a.height} → ${b.width}×${b.height}`, detail: "Content was added or removed. Review the screenshot; if intended, update baselines.", evidence: { url: p.url, image: p.screenshot } });
          continue;
        }
        const diff = new PNG({ width: a.width, height: a.height });
        const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
        const ratio = n / (a.width * a.height);
        if (ratio > v.maxDiffRatio) {
          tally.changed++;
          const diffFile = path.join(diffDir, `${slugOf(p.template)}.png`);
          fs.writeFileSync(diffFile, PNG.sync.write(diff));
          findings.push({
            plugin: this.name, severity: "medium", category: "regression", target,
            title: `Visual change: ${(ratio * 100).toFixed(2)}% of pixels differ (limit ${(v.maxDiffRatio * 100).toFixed(2)}%)`,
            detail: "Red pixels in the diff image show what changed. If the change is intended, update the baselines.",
            evidence: { url: p.url, image: path.relative(ctx.outDir, diffFile) },
          });
        }
      }
    }
    if (ctx.updateVisual) ctx.log.info(`  wrote ${tally.written} visual baseline(s)`);
    return { findings, stats: tally };
  },
};
