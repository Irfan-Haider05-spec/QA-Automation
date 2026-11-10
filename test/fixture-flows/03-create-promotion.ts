// Changes data: runs only when allowMutations is on.
export default {
  name: "Create a promotion",
  app: "business",
  async run({ page, step }: any) {
    await step("Open promotions", () => page.goto("/promotions.html"));
  },
};
