// Planted failure: the report page's API answers 500, so "Report ready" never shows.
export default {
  name: "Export customer report",
  app: "business",
  writes: false,
  async run({ page, step, see }: any) {
    await step("Open reports", () => page.goto("/reports.html"));
    await step("Wait for the report", () => see("Report ready", 3000));
  },
};
