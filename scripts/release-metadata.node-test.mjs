import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { imageTags, releaseMetadata } from "./release-metadata.mjs";

const changelog = `# Changelog

## 0.1.0 - 2026-08-07

### Added

- First release.

## 0.0.1-beta.1 - 2026-08-01

- Preview.
`;

test("extracts the exact stable release section", () => {
  assert.deepEqual(releaseMetadata({ tag: "v0.1.0", packageVersion: "0.1.0", changelog }), {
    version: "0.1.0",
    prerelease: false,
    notes: "## 0.1.0 - 2026-08-07\n\n### Added\n\n- First release.\n",
  });
});

test("marks prereleases without selecting a different changelog section", () => {
  const metadata = releaseMetadata({
    tag: "v0.0.1-beta.1",
    packageVersion: "0.0.1-beta.1",
    changelog,
  });
  assert.equal(metadata.prerelease, true);
  assert.match(metadata.notes, /Preview/u);
  assert.doesNotMatch(metadata.notes, /First release/u);
});

test("publishes latest only for stable releases", () => {
  assert.deepEqual(imageTags("MikoAgents", { version: "0.1.0", prerelease: false }), [
    "ghcr.io/mikoagents/hub:0.1.0",
    "ghcr.io/mikoagents/hub:latest",
  ]);
  assert.deepEqual(imageTags("MikoAgents", { version: "0.2.0-beta.1", prerelease: true }), [
    "ghcr.io/mikoagents/hub:0.2.0-beta.1",
  ]);
});

test("rejects a tag that does not match package.json", () => {
  assert.throws(
    () => releaseMetadata({ tag: "v0.2.0", packageVersion: "0.1.0", changelog }),
    /does not match package\.json version/u,
  );
});

test("rejects a release without matching changelog notes", () => {
  assert.throws(
    () => releaseMetadata({ tag: "v0.1.0", packageVersion: "0.1.0", changelog: "# Changelog\n" }),
    /no release section/u,
  );
});

test("release CLI checks lockfile versions before emitting publish tags", () => {
  const root = mkdtempSync(join(tmpdir(), "hub-release-metadata-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
    writeFileSync(join(root, "CHANGELOG.md"), changelog);
    const output = join(root, "outputs");
    const notes = join(root, "notes.md");
    const run = () =>
      spawnSync(
        process.execPath,
        [fileURLToPath(new URL("./release-metadata.mjs", import.meta.url)), "v0.1.0", notes],
        {
          cwd: root,
          env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_REPOSITORY_OWNER: "MikoAgents" },
          encoding: "utf8",
        },
      );
    writeFileSync(
      join(root, "package-lock.json"),
      JSON.stringify({ version: "0.1.0", packages: { "": { version: "0.0.9" } } }),
    );
    const rejected = run();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /package-lock.json version does not match/u);
    writeFileSync(
      join(root, "package-lock.json"),
      JSON.stringify({ version: "0.1.0", packages: { "": { version: "0.1.0" } } }),
    );
    assert.equal(run().status, 0);
    assert.match(readFileSync(output, "utf8"), /ghcr.io\/mikoagents\/hub:0.1.0/u);
    assert.match(readFileSync(notes, "utf8"), /First release/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
