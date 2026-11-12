/** The new-project guide and CLI share one small, runnable example. */
export function triggerStarter(name: string): string {
  return `import { defineTrigger } from "@mikoagents/hub/triggers";

export default defineTrigger({
  name: ${JSON.stringify(name)},
  description: "Log the incoming event and return its input.",

  // When it runs. Add service events or a schedule here.
  on: [{ source: "manual", event: "run" }],

  // Where it runs, what it can access, and how long it can run.
  runner: "local",
  grants: {},
  limits: { maxRuntime: "10m" },

  // What it does. Write ordinary TypeScript here.
  async run(ctx) {
    const result = { input: ctx.event.payload };
    await ctx.log("Trigger completed", result);
    return result;
  },
});
`;
}
