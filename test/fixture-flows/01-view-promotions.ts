// Reads only: lists merchant A's promotions and opens one.
export default {
  name: "View promotions",
  app: "business",
  writes: false,
  async run({ page, step, see }: any) {
    await step("Open promotions", () => page.goto("/promotions.html"));
    await see("A: 10% off");
    await step("Open a promotion", () => page.getByText("A: free coffee").click());
    await see("Promotions");
  },
};
