import { posix } from "node:path";
import ts from "typescript";
import type { TriggerArtifact } from "./contract.js";
import type { CodeField, SourceLocation, TriggerInspection } from "./inspection-types.js";

const ROOT = "/trigger";
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_AGENTS = 100;
const MAX_NODES = 50_000;
const CACHE_SIZE = 16;
const cache = new Map<string, TriggerInspection>();
type Value =
  | { kind: "scalar"; value: string | number | boolean | null; node: ts.Node }
  | { kind: "object"; properties: Map<string, Value>; dynamic: boolean; node: ts.Node }
  | { kind: "array"; items: Value[]; node: ts.Node }
  | { kind: "unknown"; node: ts.Node }
  | { kind: "missing" };
const MISSING: Value = { kind: "missing" };

/** Only syntax and bindings are read. The host cannot load files or evaluate authored code. */
export function inspectTriggerArtifact(artifact: TriggerArtifact): TriggerInspection {
  const cached = cache.get(artifact.digest);
  if (cached) return cached;
  let result: TriggerInspection;
  try {
    result = inspectTriggerSources(artifact.sources, artifact.entrypoint);
  } catch {
    // A presentation parser failure must leave source and run history available.
    result = {
      agents: [],
      locations: { entry: null, events: null, targets: null, github: null },
      limited: true,
    };
  }
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  cache.set(artifact.digest, result);
  return result;
}

export function inspectTriggerSources(
  sources: readonly { path: string; content: string }[],
  entrypoint?: string,
): TriggerInspection {
  let bytes = 0;
  let limited = false;
  const files = new Map<string, string>();
  for (const source of sources) {
    if (!/\.[cm]?[jt]sx?$/u.test(source.path)) continue;
    bytes += Buffer.byteLength(source.content);
    if (bytes > MAX_SOURCE_BYTES) {
      limited = true;
      continue;
    }
    files.set(posix.join(ROOT, source.path), source.content);
  }
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noLib: true,
    allowJs: true,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (path, language) => {
      const content = files.get(path);
      return content === undefined ? undefined : ts.createSourceFile(path, content, language, true);
    },
    getDefaultLibFileName: () => "",
    writeFile: () => {},
    getCurrentDirectory: () => ROOT,
    getDirectories: () => [],
    fileExists: (path) => files.has(path),
    readFile: (path) => files.get(path),
    getCanonicalFileName: (path) => path,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    resolveModuleNames: (names, containing) =>
      names.map((name) => {
        if (!name.startsWith(".")) return undefined;
        const base = posix.resolve(posix.dirname(containing), name);
        const stem = base.replace(/\.[cm]?jsx?$/u, "");
        const resolved = [
          base,
          ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", "/index.ts", "/index.js"].map(
            (extension) => stem + extension,
          ),
        ].find((path) => files.has(path));
        return resolved === undefined ? undefined : { resolvedFileName: resolved };
      }),
  };
  const program = ts.createProgram([...files.keys()], compilerOptions, host);
  const checker = program.getTypeChecker();
  const mutated = new Set<ts.Symbol>();
  const calls: ts.CallExpression[] = [];
  let entry: ts.Expression | undefined;
  let nodeCount = 0;
  const unknown = (node: ts.Node): Value => ({ kind: "unknown", node });
  const scalar = (value: string | number | boolean | null, node: ts.Node): Value => ({
    kind: "scalar",
    value,
    node,
  });
  function symbolFor(node: ts.Node): ts.Symbol | undefined {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  }
  function baseSymbol(node: ts.Expression): ts.Symbol | undefined {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      return baseSymbol(node.expression);
    return ts.isIdentifier(node) ? symbolFor(node) : undefined;
  }
  function member(node: ts.Expression, name: string): boolean {
    return (
      (ts.isPropertyAccessExpression(node) && node.name.text === name) ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === name)
    );
  }
  function agentCall(node: ts.CallExpression): boolean {
    const callee = node.expression;
    return (
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      member(callee, "run") &&
      member(callee.expression, "agent")
    );
  }
  function markChanged(node: ts.Expression) {
    let symbol = baseSymbol(node);
    while (symbol && !mutated.has(symbol)) {
      mutated.add(symbol);
      const declaration = symbol.valueDeclaration;
      symbol =
        declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
          ? baseSymbol(declaration.initializer)
          : undefined;
    }
  }
  function recordCall(node: ts.CallExpression) {
    if (agentCall(node)) {
      if (calls.length < MAX_AGENTS) calls.push(node);
      else limited = true;
    } else {
      // Objects passed to arbitrary functions may be changed by those functions.
      for (const argument of node.arguments) markChanged(argument);
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      [
        "push",
        "pop",
        "shift",
        "unshift",
        "splice",
        "sort",
        "reverse",
        "set",
        "delete",
        "clear",
        "fill",
        "copyWithin",
      ].includes(node.expression.name.text)
    )
      markChanged(node.expression.expression);
  }
  function visit(node: ts.Node) {
    if (++nodeCount > MAX_NODES) {
      limited = true;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      markChanged(node.left);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
    ) {
      markChanged(node.operand);
    }
    if (ts.isDeleteExpression(node)) markChanged(node.expression);
    if (ts.isCallExpression(node)) recordCall(node);
    if (
      ts.isExportAssignment(node) &&
      !node.isExportEquals &&
      entry === undefined &&
      (entrypoint
        ? posix.relative(ROOT, node.getSourceFile().fileName) === entrypoint
        : /(?:^|\/)trigger\.[cm]?[jt]sx?$/u.test(node.getSourceFile().fileName))
    )
      entry = node.expression;
    ts.forEachChild(node, visit);
  }
  for (const file of program.getSourceFiles()) {
    if (program.getSyntacticDiagnostics(file).length > 0) limited = true;
    else visit(file);
  }

  const memo = new Map<ts.Node, Value>();
  const resolving = new Set<ts.Symbol>();
  let evaluations = 0;
  function property(value: Value, key: string): Value {
    if (value.kind === "object")
      return value.properties.get(key) ?? (value.dynamic ? unknown(value.node) : MISSING);
    if (value.kind === "array") return value.items[Number(key)] ?? MISSING;
    return value.kind === "unknown" ? value : MISSING;
  }
  function resolveSymbol(symbol: ts.Symbol | undefined, node: ts.Node, depth: number): Value {
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    if (!symbol || mutated.has(symbol) || resolving.has(symbol)) return unknown(node);
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !(declaration.parent.flags & ts.NodeFlags.Const) ||
      !declaration.initializer
    )
      return unknown(node);
    resolving.add(symbol);
    const result = resolve(declaration.initializer, depth + 1);
    resolving.delete(symbol);
    return result;
  }
  function resolve(node: ts.Node | undefined, depth = 0): Value {
    if (!node) return MISSING;
    if (++evaluations > 10_000 || depth > 40) {
      limited = true;
      return unknown(node);
    }
    const cached = memo.get(node);
    if (cached) return cached;
    const result = evaluate(node, depth);
    memo.set(node, result);
    return result;
  }
  function evaluate(node: ts.Node, depth: number): Value {
    if (ts.isStringLiteralLike(node)) return scalar(node.text, node);
    if (ts.isNumericLiteral(node)) return scalar(Number(node.text), node);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return scalar(true, node);
    if (node.kind === ts.SyntaxKind.FalseKeyword) return scalar(false, node);
    if (node.kind === ts.SyntaxKind.NullKeyword) return scalar(null, node);
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node)
    )
      return resolve(node.expression, depth + 1);
    if (ts.isIdentifier(node)) return resolveSymbol(symbolFor(node), node, depth);
    if (ts.isShorthandPropertyAssignment(node))
      return resolveSymbol(checker.getShorthandAssignmentValueSymbol(node), node, depth);
    if (ts.isPropertyAccessExpression(node))
      return property(resolve(node.expression, depth + 1), node.name.text);
    if (ts.isElementAccessExpression(node)) {
      const key = resolve(node.argumentExpression, depth + 1);
      return key.kind === "scalar"
        ? property(resolve(node.expression, depth + 1), String(key.value))
        : unknown(node);
    }
    if (ts.isObjectLiteralExpression(node)) return evaluateObject(node, depth);
    if (ts.isArrayLiteralExpression(node)) {
      if (node.elements.some(ts.isSpreadElement)) return unknown(node);
      return { kind: "array", items: node.elements.map((item) => resolve(item, depth + 1)), node };
    }
    return evaluateText(node, depth);
  }
  function evaluateText(node: ts.Node, depth: number): Value {
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const part of node.templateSpans) {
        const value = resolve(part.expression, depth + 1);
        if (value.kind !== "scalar") return unknown(node);
        text += String(value.value) + part.literal.text;
      }
      return scalar(text, node);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = resolve(node.left, depth + 1);
      const right = resolve(node.right, depth + 1);
      if (
        left.kind === "scalar" &&
        right.kind === "scalar" &&
        (typeof left.value === "string" || typeof right.value === "string")
      )
        return scalar(String(left.value) + String(right.value), node);
    }
    return unknown(node);
  }
  function evaluateObject(node: ts.ObjectLiteralExpression, depth: number): Value {
    const properties = new Map<string, Value>();
    let dynamic = false;
    for (const item of node.properties) {
      if (ts.isSpreadAssignment(item)) {
        const spread = resolve(item.expression, depth + 1);
        if (spread.kind !== "object" || spread.dynamic) {
          properties.clear();
          dynamic = true;
        }
        if (spread.kind === "object")
          spread.properties.forEach((value, key) => properties.set(key, value));
        continue;
      }
      const key = ts.isComputedPropertyName(item.name)
        ? resolve(item.name.expression, depth + 1)
        : scalar(item.name.getText().replace(/^["']|["']$/gu, ""), item.name);
      if (key.kind !== "scalar") {
        properties.clear();
        dynamic = true;
        continue;
      }
      let value = unknown(item);
      if (ts.isPropertyAssignment(item)) value = resolve(item.initializer, depth + 1);
      else if (ts.isShorthandPropertyAssignment(item)) value = resolve(item, depth + 1);
      properties.set(String(key.value), value);
    }
    return { kind: "object", properties, dynamic, node };
  }
  function location(node: ts.Node): SourceLocation {
    const file = node.getSourceFile();
    return {
      path: posix.relative(ROOT, file.fileName),
      line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      column: file.getLineAndCharacterOfPosition(node.getStart()).character + 1,
      endLine: file.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
    };
  }
  function field(value: Value): CodeField {
    if (value.kind === "missing")
      return { status: "unset", value: null, expression: null, source: null };
    const source = location(value.node);
    if (value.kind === "scalar")
      return {
        status: "known",
        value: value.value === null ? null : preview(String(value.value)),
        expression: null,
        source,
      };
    return {
      status: "runtime",
      value: null,
      expression: value.node.getText().slice(0, 1000),
      source,
    };
  }
  let configuration = entry;
  if (configuration && ts.isCallExpression(configuration))
    configuration = configuration.arguments[0];
  const config = resolve(configuration);
  const fallback =
    sources.find((source) =>
      entrypoint ? source.path === entrypoint : /(?:^|\/)trigger\.[cm]?[jt]sx?$/u.test(source.path),
    ) ?? sources[0];
  let entryLocation: SourceLocation | null = null;
  if (configuration) entryLocation = location(configuration);
  else if (fallback) entryLocation = { path: fallback.path, line: 1, column: 1, endLine: 1 };
  const grants = property(config, "grants");
  return {
    agents: calls.map((call) => {
      const options = resolve(call.arguments[1]);
      const agent = property(options, "agent");
      return {
        source: location(call),
        id: field(resolve(call.arguments[0])),
        target: field(property(options, "target")),
        provider: field(property(agent, "provider")),
        model: field(property(agent, "model")),
        mode: field(property(agent, "mode")),
        thinking: field(property(agent, "thinkingOptionId")),
        prompt: field(property(options, "prompt")),
        github: field(property(options, "github")),
        maxRuntime: field(property(options, "maxRuntime")),
        idleTimeout: field(property(options, "idleTimeout")),
        startupTimeout: field(property(options, "startupTimeout")),
      };
    }),
    locations: {
      entry: entryLocation,
      events: field(property(config, "on")).source ?? entryLocation,
      targets: field(property(grants, "targets")).source ?? entryLocation,
      github: field(property(grants, "github")).source ?? entryLocation,
    },
    limited,
  };
}

function preview(value: string): string {
  return value.length <= 16_000 ? value : value.slice(0, 16_000) + "\n… Preview truncated.";
}
