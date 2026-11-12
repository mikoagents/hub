import { z } from "zod";
/* oxlint-disable complexity -- CLI command dispatch keeps the complete operator interface in one auditable switch. */
import { readFile, writeFile, mkdir, open, rm } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { buildTrigger } from "./build.js";
import { triggerRequest } from "./http-client.js";
import { runTriggerRunner } from "./runner.js";
import { triggerStarter } from "./starter.js";

export async function runTriggerCommand(args: string[]): Promise<void> {
  const command = args[0];
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 1; index < args.length; index++) {
    const item = args[index]!;
    if (item.startsWith("--")) {
      const value = args[++index];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`${item} requires a value`);
      flags[item.slice(2)] = value;
    } else positionals.push(item);
  }
  const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (command === "init") {
    const directory = resolve(positionals[0] ?? "trigger");
    const triggerName = flags["name"] ?? basename(directory);
    if (!/^[a-z][a-z0-9_-]*$/u.test(triggerName))
      throw new Error("Use a lowercase project name, or pass --name <trigger-name>");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "trigger.ts"), triggerStarter(triggerName), { flag: "wx" });
    print({
      directory,
      name: triggerName,
      entry: join(directory, "trigger.ts"),
      next: "miko trigger check <entry>",
    });
    return;
  }
  if (command === "check" || command === "build") {
    const artifact = await buildTrigger(positionals[0] ?? "trigger.ts", flags["project-dir"]);
    if (flags["out"] !== undefined)
      await writeFile(resolve(flags["out"]), `${JSON.stringify(artifact)}\n`, { mode: 0o600 });
    print({
      valid: true,
      name: artifact.manifest.name,
      digest: artifact.digest,
      sources: artifact.sources.map((file) => file.path),
    });
    return;
  }
  const url = required(flags, "url");
  const token = (await readFile(resolve(required(flags, "token-file")), "utf8")).trim();
  if (token.length === 0) throw new Error("Credential file is empty");
  const request = <T>(path: string, body?: unknown) =>
    triggerRequest<T>(url, `/api/v1/triggers${path}`, token, body);
  const name = () => {
    if (positionals[0] === undefined) throw new Error("Trigger name or id required");
    return encodeURIComponent(positionals[0]);
  };
  switch (command) {
    case "deploy": {
      const artifact =
        flags["artifact"] === undefined
          ? await buildTrigger(positionals[0] ?? "trigger.ts", flags["project-dir"])
          : (JSON.parse(await readFile(resolve(flags["artifact"]), "utf8")) as unknown);
      print(await request("/install", { artifact }));
      break;
    }
    case "list":
      print(await request(""));
      break;
    case "run":
      print(
        await request(`/${name()}/run`, {
          ...(flags["delivery-key"] === undefined ? {} : { deliveryKey: flags["delivery-key"] }),
          input:
            flags["input-file"] === undefined
              ? null
              : (JSON.parse(await readFile(resolve(flags["input-file"]), "utf8")) as unknown),
        }),
      );
      break;
    case "event":
      print(
        await request(
          `/${name()}/events`,
          JSON.parse(await readFile(resolve(required(flags, "input-file")), "utf8")),
        ),
      );
      break;
    case "runs":
      print(await request(`/${name()}/runs`));
      break;
    case "logs":
      print(await request(`/runs/${name()}`));
      break;
    case "cancel":
      print(await request(`/runs/${name()}/cancel`, {}));
      break;
    case "enable":
    case "disable":
      print(await request(`/${name()}/enabled`, { enabled: command === "enable" }));
      break;
    case "runner-enroll": {
      const output = resolve(required(flags, "out"));
      const file = await open(output, "wx", 0o600);
      try {
        const result = await request<{ id: string; name: string; token: string }>("/runners", {
          name: positionals[0] ?? "local",
        });
        await file.writeFile(`${result.token}\n`);
        print({ id: result.id, name: result.name, credentialFile: output });
      } catch (error) {
        await rm(output, { force: true });
        throw error;
      } finally {
        await file.close();
      }
      break;
    }
    case "runner": {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      const secrets =
        flags["secrets-file"] === undefined
          ? {}
          : z
              .record(z.string(), z.string())
              .parse(JSON.parse(await readFile(resolve(flags["secrets-file"]), "utf8")));
      try {
        await runTriggerRunner({
          url,
          token,
          directory: resolve(required(flags, "directory")),
          secrets,
          concurrency: Number(flags["concurrency"] ?? 1),
          signal: controller.signal,
          onError: (error) => process.stderr.write(`${error.message}\n`),
        });
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
      break;
    }
    default:
      throw new Error(
        "Usage: miko trigger <init|check|build|deploy|list|run|event|runs|logs|cancel|enable|disable|runner-enroll|runner> [entry/name] --url <Hub URL> --token-file <credential file>",
      );
  }
}

function required(flags: Record<string, string>, key: string): string {
  const value = flags[key];
  if (value === undefined || value.trim().length === 0) throw new Error(`--${key} is required`);
  return value;
}
