import { createHash } from "node:crypto";
import { z } from "zod";
import { RecurrenceSchema } from "../schedule/recurrence.js";
import { parseDurationMs } from "../../config/compiler.js";
import {
  AuthoredGitHubAuthoritySchema,
  validateGitHubPermissions,
} from "../../config/github-authority.js";
import type { TriggerManifest, TriggerEvent } from "./sdk.js";
import type { TriggerValue } from "./sdk.js";
import { TriggerAgentSchema } from "../configuration/schema.js";
import { WorktreeTargetSchema } from "../../config/compiler.js";
import { matchesPattern } from "./patterns.js";

export { matchesPattern } from "./patterns.js";

export const CodeAgentOptionsSchema = z
  .object({
    target: z.string().min(1),
    agent: TriggerAgentSchema,
    prompt: z.string().min(1),
    maxRuntime: z.string().min(1),
    idleTimeout: z.string().min(1),
    startupTimeout: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    github: z.string().min(1).optional(),
    worktree: WorktreeTargetSchema.optional(),
    continuation: z
      .object({ key: z.string().min(1).max(512) })
      .strict()
      .optional(),
    output: z
      .object({ schema: z.record(z.string(), z.unknown()) })
      .strict()
      .optional(),
    outputs: z
      .record(
        z.string(),
        z
          .object({ required: z.boolean().optional(), max: z.number().int().positive().optional() })
          .strict(),
      )
      .optional(),
    autoArchive: z.boolean().optional(),
    background: z.boolean().optional(),
  })
  .strict();

export function jsonValue(value: unknown): TriggerValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (
    typeof value === "object" &&
    value !== null &&
    [Object.prototype, null].includes(Reflect.getPrototypeOf(value))
  )
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child)]));
  throw new Error("Expected a JSON value");
}

export function ownGrant<T>(
  grants: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  return grants !== undefined && Object.hasOwn(grants, key) ? grants[key] : undefined;
}

const name = z.string().regex(/^[a-z][a-z0-9_-]*$/u);
const eventPattern = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_.*:-]+$/u);
const duration = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    try {
      parseDurationMs(value, "duration");
    } catch {
      ctx.addIssue({ code: "custom", message: "Expected a positive duration such as 10m or 2h" });
    }
  });
const subscription = z
  .object({
    source: name,
    event: z.union([eventPattern, z.array(eventPattern).min(1)]),
    connection: z.string().min(1).optional(),
    resource: z.string().min(1).optional(),
    recurrence: RecurrenceSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.source === "schedule") !== (value.recurrence !== undefined))
      ctx.addIssue({ code: "custom", message: "Only schedule subscriptions require recurrence" });
    if (value.source === "schedule" && !matchesPattern("tick", value.event))
      ctx.addIssue({ code: "custom", message: "Schedule event patterns must include tick" });
    if (
      ["github", "slack", "discord", "linear"].includes(value.source) &&
      value.connection === undefined
    )
      ctx.addIssue({ code: "custom", message: "Provider events require an explicit connection" });
  });
export const TriggerManifestSchema = z
  .object({
    name,
    description: z.string().max(2000).optional(),
    diagram: z.string().trim().min(1).max(12000).optional(),
    on: z.array(subscription).min(1).max(100),
    runner: name,
    grants: z
      .object({
        targets: z
          .record(
            name,
            z
              .object({
                daemon: z.string().min(1),
                cwd: z.string().startsWith("/"),
                providers: z.array(z.string().min(1)).min(1),
                env: z.record(z.string(), z.string()).optional(),
              })
              .strict(),
          )
          .optional(),
        github: z
          .record(
            name,
            AuthoredGitHubAuthoritySchema.extend({
              repositories: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/u)).min(1),
              permissions: z.record(z.string(), z.enum(["read", "write", "admin"])),
            }).omit({ duration: true }),
          )
          .optional(),
        secrets: z
          .array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/u))
          .max(100)
          .optional(),
      })
      .strict(),
    limits: z
      .object({ maxRuntime: duration, maxAgentRuns: z.number().int().positive().optional() })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [alias, grant] of Object.entries(value.grants.github ?? {})) {
      try {
        validateGitHubPermissions(grant.permissions, `grants.github.${alias}.permissions`);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          path: ["grants", "github", alias, "permissions"],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (value.on.filter((item) => item.source === "schedule").length > 1)
      ctx.addIssue({
        code: "custom",
        message: "One Trigger can declare one schedule, alongside any other events",
      });
  });

const fileSchema = z
  .object({ path: z.string().min(1).max(500), content: z.string() })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.path.startsWith("/") ||
      value.path.includes("\\") ||
      value.path
        .split("/")
        .some((part) => part === ".." || part === "." || part === "" || part.startsWith(".env"))
    )
      ctx.addIssue({
        code: "custom",
        message: "Source path must be a regular project-relative path",
      });
  });
export const TriggerArtifactSchema = z
  .object({
    format: z.literal("trigger-code-v1"),
    manifest: TriggerManifestSchema,
    code: z
      .string()
      .min(1)
      .max(16 * 1024 * 1024),
    sources: z.array(fileSchema).min(1).max(1000),
    entrypoint: z.string().min(1).max(500).optional(),
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type TriggerArtifact = z.infer<typeof TriggerArtifactSchema>;

export function stableJson(value: unknown): string {
  function normalize(item: unknown): unknown {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (
      typeof item === "object" &&
      item !== null &&
      [Object.prototype, null].includes(Reflect.getPrototypeOf(item))
    )
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, normalize(child)]),
      );
    throw new Error(
      "Trigger data must be JSON serializable; undefined, dates and non-finite numbers are not supported",
    );
  }
  return JSON.stringify(normalize(value));
}
export function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
export function artifactDigest(artifact: Omit<TriggerArtifact, "digest">): string {
  return digest(artifact);
}
export function validateArtifact(value: unknown): TriggerArtifact {
  const artifact = TriggerArtifactSchema.parse(value);
  const { digest: expected, ...body } = artifact;
  if (artifactDigest(body) !== expected)
    throw new Error("Trigger artifact digest does not match its contents");
  if (new Set(artifact.sources.map((file) => file.path)).size !== artifact.sources.length)
    throw new Error("Trigger source paths must be unique");
  if (
    artifact.entrypoint !== undefined &&
    !artifact.sources.some((file) => file.path === artifact.entrypoint)
  )
    throw new Error("Trigger entrypoint must reference a source file");
  if (Buffer.byteLength(stableJson(artifact)) > 24 * 1024 * 1024)
    throw new Error("Trigger artifact exceeds 24 MiB");
  return artifact;
}
export function subscribes(manifest: TriggerManifest, event: TriggerEvent): boolean {
  return manifest.on.some(
    (item) =>
      item.source === event.source &&
      matchesPattern(event.type, item.event) &&
      (item.connection === undefined || item.connection === event.connection) &&
      (item.resource === undefined || item.resource === event.resource),
  );
}
