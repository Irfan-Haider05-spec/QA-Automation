// Trusted local plugins run with CLI privileges. Do not accept them from uploads.
import { z } from "zod";
export default {
  apiVersion: 1,
  name: "example-health",
  layer: "api",
  description: "Example plugin with a checked settings schema",
  needs: ["baseUrl"],
  settingsSchema: z.object({ path: z.string().regex(/^\/(?!\/)/).default("/health") }).strict(),
  async run(ctx) {
    const { path } = ctx.config.pluginSettings["example-health"];
    const response = await ctx.http.send({ method: "GET", path, retry: false });
    if (response.networkError) throw new Error("Health endpoint unavailable");
    return response.status === 200 ? [] : [{ plugin: "example-health", severity: "high", category: "env", title: "Health endpoint returned an unexpected status", target: path, evidence: { status: response.status } }];
  },
};
