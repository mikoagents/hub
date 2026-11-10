import { expect, type Page } from "@playwright/test";
import { artifactDigest, type TriggerArtifact } from "../../src/triggers/code/contract.js";

export class OrganizationTriggers {
  constructor(private readonly page: Page) {}
  async open() {
    await this.page.getByRole("link", { name: "Triggers", exact: true }).click();
    await this.page.reload();
    await expect(this.page.getByRole("heading", { name: "Triggers", level: 1 })).toBeVisible();
  }
  async startNew() {
    await this.page.getByRole("link", { name: "New trigger" }).click();
    await expect(this.page).toHaveURL(/\/triggers\/new$/u);
    await expect(this.page.getByRole("heading", { name: "New trigger", level: 1 })).toBeVisible();
    await expect(
      this.page.getByText("paseo-hub trigger init my-trigger", { exact: false }),
    ).toBeVisible();
  }
}

export function manualTriggerArtifact(name: string, daemon?: string): TriggerArtifact {
  const options = {
    target: "local",
    agent: { provider: "codex", model: "gpt-5.4", mode: "full-access", thinkingOptionId: "high" },
    prompt: "Handle the explicitly submitted event.",
    maxRuntime: "5m",
    idleTimeout: "1m",
  };
  const code =
    daemon === undefined
      ? "export default {async run(){return null}};"
      : `export default {async run(ctx){return ctx.agent.run("agent",${JSON.stringify(options)});}};`;
  const body = {
    format: "trigger-code-v1" as const,
    manifest: {
      name,
      runner: "browser",
      on: [{ source: "manual", event: "run" }],
      grants:
        daemon === undefined
          ? {}
          : { targets: { local: { daemon, cwd: "/workspace", providers: ["codex"] } } },
      limits: { maxRuntime: "10m" },
    },
    code,
    sources: [{ path: "trigger.ts", content: code }],
  };
  return { ...body, digest: artifactDigest(body) };
}
