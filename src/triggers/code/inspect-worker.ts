import { pathToFileURL } from "node:url";
const path = process.argv[2];
if (path === undefined) throw new Error("Trigger module path required");
const module: unknown = await import(pathToFileURL(path).href);
if (typeof module !== "object" || module === null) throw new Error("Trigger module is invalid");
const definition: unknown = Reflect.get(module, "default");
if (
  typeof definition !== "object" ||
  definition === null ||
  typeof Reflect.get(definition, "run") !== "function"
)
  throw new Error("Default export must be defineTrigger({ ..., run(ctx) { ... } })");
const manifest = Object.fromEntries(Object.entries(definition).filter(([key]) => key !== "run"));
process.send?.(manifest);
