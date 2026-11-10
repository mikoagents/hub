import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it, vi } from "vitest";
import { runTriggerCommand } from "./cli.js";
import { buildTrigger } from "./build.js";

it("initializes independently deployable identities and refuses to overwrite a workflow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hub-trigger-init-"));
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    const projects = [join(directory, "first"), join(directory, "second")];
    for (const path of projects) await runTriggerCommand(["init", path]);
    const artifacts = await Promise.all(
      projects.map((path) => buildTrigger(join(path, "trigger.ts"))),
    );
    assert.deepEqual(
      artifacts.map((artifact) => artifact.manifest.name),
      ["first", "second"],
    );
    await assert.rejects(runTriggerCommand(["init", projects[0]!]), /EEXIST/u);
    assert.match(await readFile(join(projects[0]!, "trigger.ts"), "utf8"), /name: "first"/u);
    await runTriggerCommand([
      "init",
      join(directory, "Custom Directory"),
      "--name",
      "explicit-name",
    ]);
    assert.equal(
      (await buildTrigger(join(directory, "Custom Directory", "trigger.ts"))).manifest.name,
      "explicit-name",
    );
  } finally {
    output.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
