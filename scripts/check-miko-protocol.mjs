import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compatibility = JSON.parse(await readFile(join(root, "miko-compatibility.json"), "utf8"));
if (!/^[a-f0-9]{40}$/.test(compatibility.daemonCommit))
  throw new Error("Miko source must be pinned to an immutable commit");
const source = await readFile(join(root, "src/miko/protocol.ts"));
if (digest(source) !== compatibility.protocolSha256)
  throw new Error("Vendored execution protocol differs from its accepted digest");
const versionMatch = source
  .toString("utf8")
  .match(/EXECUTION_PROTOCOL_VERSION\s*=\s*["']([^"']+)/u);
if (versionMatch?.[1] !== compatibility.protocolVersion)
  throw new Error("Execution protocol version differs from the compatibility record");
const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
if (!workflow.includes(`MIKO_E2E_COMMIT: ${compatibility.daemonCommit}`))
  throw new Error("CI's daemon pin differs from the accepted compatibility record");
if (process.argv[2]) {
  const daemon = resolve(process.argv[2]);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: daemon, encoding: "utf8" }).trim();
  if (head !== compatibility.daemonCommit)
    throw new Error(`Expected daemon ${compatibility.daemonCommit}, received ${head}`);
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: daemon,
    encoding: "utf8",
  }).trim();
  if (dirty) throw new Error("Source-built acceptance requires a clean daemon checkout");
  const canonical = await readFile(join(daemon, compatibility.protocolPath));
  if (!source.equals(canonical))
    throw new Error("Hub and daemon execution protocol sources differ");
}
process.stdout.write(
  `Miko execution protocol ${compatibility.protocolVersion}: accepted schema and source pin verified.\n`,
);
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
