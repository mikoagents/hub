import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "vitest";
import { compileHubBundle, type HubBundleFile } from "./bundle.js";

const exampleRoot = "examples/single-repo-team-bot";
const exampleFiles = [
  ".miko/hub.yml",
  ".miko/workflows/discord.yml",
  ".miko/workflows/github.yml",
  ".miko/workflows/slack.yml",
  ".miko/workflows/partials/classifier.md",
  ".miko/workflows/partials/github-progress.md",
  ".miko/workflows/partials/progress.md",
  ".miko/workflows/partials/safety.md",
  ".miko/workflows/partials/worker.md",
] as const;

describe("public Hub examples", () => {
  it("keeps the single-repository team bot deployable", async () => {
    const files: HubBundleFile[] = await Promise.all(
      exampleFiles.map(async (path) => ({
        path,
        content: await readFile(join(exampleRoot, path), "utf8"),
      })),
    );

    const bundle = compileHubBundle(files);

    assert.deepEqual(
      bundle.configuration.triggers.map(({ name }) => name),
      ["discord-mention", "github-issue-comment", "slack-mention"],
    );
    for (const trigger of bundle.configuration.triggers) {
      assert.deepEqual(
        trigger.steps.map(({ id, environment }) => ({ id, environment })),
        [
          { id: "classify", environment: "repository" },
          { id: "work", environment: "repository" },
        ],
      );
    }
    assert.deepEqual(bundle.agentValidationTargets.map(({ name }) => name).sort(), [
      "classifier",
      "worker",
    ]);
  });
});
