import { build } from "esbuild";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { workerPath } from "./runner.js";
import {
  artifactDigest,
  TriggerManifestSchema,
  validateArtifact,
  type TriggerArtifact,
} from "./contract.js";

/** Build only runs on the author's machine/CI. The Hub never evaluates authored modules. */
export async function buildTrigger(
  entry: string,
  projectDirectory?: string,
): Promise<TriggerArtifact> {
  const entryPath = await realpath(resolve(entry));
  const root =
    projectDirectory === undefined ? dirname(entryPath) : await realpath(resolve(projectDirectory));
  const entryRelative = relative(root, entryPath);
  if (entryRelative.startsWith("..") || isAbsolute(entryRelative))
    throw new Error("Trigger entry must be inside its project directory");
  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: {
      js: 'import { createRequire as __hubCreateRequire } from "node:module"; const require = __hubCreateRequire(import.meta.url);',
    },
    sourcemap: "inline",
    metafile: true,
    absWorkingDir: root,
    alias: {
      "@getpaseo/hub/triggers": fileURLToPath(
        new URL(
          existsSync(fileURLToPath(new URL("./sdk.js", import.meta.url))) ? "./sdk.js" : "./sdk.ts",
          import.meta.url,
        ),
      ),
    },
  });
  const code = result.outputFiles[0]?.text;
  if (code === undefined) throw new Error("Trigger build produced no executable module");
  const directory = await mkdtemp(join(tmpdir(), "hub-trigger-build-"));
  try {
    const filename = join(directory, "trigger.mjs");
    await writeFile(filename, code);
    const manifest = TriggerManifestSchema.parse(await inspectModule(filename));
    const sources: TriggerArtifact["sources"] = [];
    for (const input of Object.keys(result.metafile.inputs)) {
      if (input.includes("/triggers/code/sdk.")) continue;
      const absolute = resolve(root, input);
      const path = relative(root, absolute);
      if (path.startsWith("..") || isAbsolute(path)) {
        if (absolute.includes("/node_modules/")) continue;
        throw new Error(`Shared source must be inside the Trigger project: ${input}`);
      }
      if (path.startsWith("node_modules/")) continue;
      sources.push({ path, content: await readFile(resolve(root, input), "utf8") });
    }
    for (const path of ["package.json", "package-lock.json"]) {
      const content = await readFile(join(root, path), "utf8").catch(() => undefined);
      if (content !== undefined && !sources.some((file) => file.path === path))
        sources.push({ path, content });
    }
    const body = {
      format: "trigger-code-v1" as const,
      manifest,
      code,
      entrypoint: entryRelative,
      sources: sources.sort((a, b) => a.path.localeCompare(b.path)),
    };
    return validateArtifact({ ...body, digest: artifactDigest(body) });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function inspectModule(filename: string): Promise<unknown> {
  return new Promise((resolveResult, reject) => {
    const worker = workerPath("inspect-worker");
    const child = fork(worker.path, [filename], {
      execArgv: ["--max-old-space-size=128", ...worker.execArgv],
      env: { PATH: process.env["PATH"] },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Trigger module inspection exceeded 10 seconds"));
    }, 10_000);
    child.once("message", (message) => {
      clearTimeout(timeout);
      resolveResult(message);
      child.kill();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== null && code !== 0)
        reject(new Error(`Trigger module inspection failed: ${stderr}`));
    });
  });
}
