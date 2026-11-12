import { posix } from "node:path";
import ts from "typescript";
import type { TriggerArtifact } from "./contract.js";
import type { CodeField, SourceLocation, TriggerInspection } from "./inspection-types.js";

const ROOT = "/trigger";
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_AGENTS = 100;
const MAX_NODES = 50_000;
const MAX_CHANGES = 100_000;
const MAX_ALIASES = 100;
const CACHE_SIZE = 16;
const cache = new Map<string, TriggerInspection>();
/** Methods that change the array, map or set they are called on. */
const MUTATING = new Set([
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
]);
/** Operators whose result is either side. */
const LOGICAL = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);
/** Operators whose result is their right side. */
const RESULT_ON_RIGHT = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.CommaToken]);
/** A path key that stands for every member at once: `{ ...source }` hands each of them on. */
const EVERY = "\u0000every";
/**
 * What an expression evaluates to, as far as the code fixes it. An object's `dynamic` is where keys
 * it does not name may come from — a spread of something unread. A `choice` is one of its options,
 * picked when the workflow runs. An `unknown` value is computed when the workflow runs, by `node`
 * followed by the keys in `path`.
 */
type Value =
  | { kind: "scalar"; value: string | number | boolean | null; node: ts.Node }
  | { kind: "object"; properties: Map<string, Value>; dynamic: ts.Node | null; node: ts.Node }
  | { kind: "array"; items: Value[]; node: ts.Node }
  | { kind: "choice"; options: Value[]; node: ts.Node }
  | { kind: "unknown"; node: ts.Node; path: readonly string[] }
  | { kind: "missing" };
const MISSING: Value = { kind: "missing" };
/**
 * A change the code makes at `path` inside a binding. A `replaced` member gets a new value. Any
 * other change hands the member to code this inspection does not read, which may change what is
 * inside an object or array but cannot turn one string or number into another.
 */
interface Change {
  path: readonly string[];
  replaced: boolean;
}
/** An expression a binding takes its value from, and the keys it follows into it. */
interface Origin {
  node: ts.Expression;
  path: string[];
  /** False when a rest element or a computed key cannot say which member the binding takes. */
  exact: boolean;
}
type Wrapper =
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.SatisfiesExpression
  | ts.TypeAssertion
  | ts.NonNullExpression
  | ts.AwaitExpression;
type Callable = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

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
  const changes = new Map<ts.Symbol, Map<string, Change>>();
  const calls: ts.CallExpression[] = [];
  let entry: ts.Expression | undefined;
  let nodeCount = 0;
  let changeCount = 0;
  /** Set once a change may have gone unrecorded; after that no binding's value is trusted. */
  let overwhelmed = false;
  function symbolFor(node: ts.Node): ts.Symbol | undefined {
    // The name in `{ agent }` declares a property; the value it reads is another symbol.
    const symbol =
      ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
    return symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
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
  /** Adds a change to a binding. False when it is already there, so each one is followed once. */
  function record(symbol: ts.Symbol, path: readonly string[], replaced: boolean): boolean {
    const recorded = changes.get(symbol) ?? new Map<string, Change>();
    changes.set(symbol, recorded);
    const key = JSON.stringify([replaced, ...path]);
    if (recorded.has(key)) return false;
    recorded.set(key, { path, replaced });
    return true;
  }
  /**
   * Records that the code changes `path` inside whatever `node` evaluates to, then follows that
   * value to every binding that may share it: an alias, a literal's member, a spread, a return.
   */
  function change(
    node: ts.Expression,
    path: readonly string[],
    replaced: boolean,
    chain = new Set<ts.Symbol>(),
  ) {
    if (overwhelmed) return;
    if (++changeCount > MAX_CHANGES || chain.size > MAX_ALIASES) {
      overwhelmed = true;
      limited = true;
      return;
    }
    const target = skip(node);
    if (ts.isConditionalExpression(target)) {
      change(target.whenTrue, path, replaced, chain);
      change(target.whenFalse, path, replaced, chain);
    } else if (ts.isBinaryExpression(target)) {
      const operator = target.operatorToken.kind;
      if (LOGICAL.has(operator)) change(target.left, path, replaced, chain);
      if (LOGICAL.has(operator) || RESULT_ON_RIGHT.has(operator))
        change(target.right, path, replaced, chain);
    } else if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) {
      changeLiteral(target, path, replaced, chain);
    } else if (ts.isCallExpression(target)) {
      changeResult(target, path, replaced, chain);
    } else if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      const key = ts.isPropertyAccessExpression(target)
        ? target.name.text
        : literalKey(target.argumentExpression);
      // A key the code computes may be any member, so the change lands on the whole container.
      if (key === undefined) change(target.expression, [], false, chain);
      else change(target.expression, [key, ...path], replaced, chain);
    } else if (ts.isIdentifier(target)) {
      changeBinding(target, path, replaced, chain);
    }
  }
  function changeBinding(
    node: ts.Identifier,
    path: readonly string[],
    replaced: boolean,
    chain: Set<ts.Symbol>,
  ) {
    const symbol = symbolFor(node);
    if (!symbol || !record(symbol, path, replaced) || chain.has(symbol)) return;
    // A new value for the binding itself leaves the value it held alone.
    if (replaced && path.length === 0) return;
    chain.add(symbol);
    for (const origin of origins(symbol.valueDeclaration)) {
      if (origin.exact) change(origin.node, [...origin.path, ...path], replaced, chain);
      else change(origin.node, origin.path, false, chain);
    }
    chain.delete(symbol);
  }
  /** A literal's members are the values it holds, and a spread shares its source's members. */
  function changeLiteral(
    node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
    path: readonly string[],
    replaced: boolean,
    chain: Set<ts.Symbol>,
  ) {
    // A member put in place of another leaves the value it replaced alone.
    if (replaced && path.length <= 1) return;
    const [key, ...rest] = path;
    const object = ts.isObjectLiteralExpression(node);
    let shifted = false;
    for (const [index, item] of (object ? node.properties : node.elements).entries()) {
      if (ts.isSpreadAssignment(item) || ts.isSpreadElement(item)) {
        // An array spread moves its members to positions the literal does not name.
        shifted = true;
        if (key === undefined) change(item.expression, [EVERY], false, chain);
        else change(item.expression, [object ? key : EVERY, ...rest], replaced, chain);
        continue;
      }
      const value = memberValue(item);
      const name = object || shifted ? memberName(item) : String(index);
      if (value === undefined) continue;
      if (key === undefined) change(value, [], false, chain);
      else if (key === EVERY || name === undefined || name === key)
        change(value, rest, replaced, chain);
    }
  }
  /**
   * A call evaluates to what its function returns: a local function's returns are read, and a
   * method may return the object it is called on or anything inside it.
   */
  function changeResult(
    node: ts.CallExpression,
    path: readonly string[],
    replaced: boolean,
    chain: Set<ts.Symbol>,
  ) {
    const callee = skip(node.expression);
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      change(callee.expression, [], false, chain);
      return;
    }
    const symbol = ts.isIdentifier(callee) ? symbolFor(callee) : undefined;
    const fn = symbol && callable(symbol);
    if (!symbol || !fn || chain.has(symbol)) return;
    chain.add(symbol);
    for (const result of exits(fn).results) if (result) change(result, path, replaced, chain);
    chain.delete(symbol);
  }
  function recordCall(node: ts.CallExpression | ts.NewExpression) {
    if (ts.isCallExpression(node) && agentCall(node)) {
      if (calls.length < MAX_AGENTS) calls.push(node);
      else limited = true;
      return;
    }
    // Anything handed to code this inspection does not read may be changed there.
    for (const argument of node.arguments ?? []) {
      if (ts.isSpreadElement(argument)) change(argument.expression, [EVERY], false);
      else change(argument, [], false);
    }
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return;
    // A method sees what it is called on. One that works in place may change anything there; any
    // other may still hand its members to a callback that changes them.
    const name = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : literalKey(callee.argumentExpression);
    change(callee.expression, name === undefined || MUTATING.has(name) ? [] : [EVERY], false);
  }
  /** Records each target of an assignment, through any destructuring pattern it is written as. */
  function assigned(target: ts.Expression) {
    const node = skip(target);
    if (ts.isObjectLiteralExpression(node)) {
      for (const item of node.properties) {
        if (ts.isPropertyAssignment(item)) assigned(item.initializer);
        else if (ts.isShorthandPropertyAssignment(item)) assigned(item.name);
        else if (ts.isSpreadAssignment(item)) assigned(item.expression);
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const item of node.elements) assigned(ts.isSpreadElement(item) ? item.expression : item);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      // A target with a default: `[first = "none"] = list`.
      assigned(node.left);
    } else if (!ts.isOmittedExpression(node)) {
      change(node, [], true);
    }
  }
  function isEntry(node: ts.Node): node is ts.ExportAssignment {
    return (
      ts.isExportAssignment(node) &&
      !node.isExportEquals &&
      entry === undefined &&
      (entrypoint
        ? posix.relative(ROOT, node.getSourceFile().fileName) === entrypoint
        : /(?:^|\/)trigger\.[cm]?[jt]sx?$/u.test(node.getSourceFile().fileName))
    );
  }
  function visit(node: ts.Node) {
    if (++nodeCount > MAX_NODES) {
      limited = true;
      return;
    }
    if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) {
      assigned(node.left);
      // What lands in another binding may be changed through it.
      change(node.right, [], false);
    } else if (isStep(node)) {
      change(node.operand, [], true);
    } else if (ts.isDeleteExpression(node)) {
      change(node.expression, [], true);
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      recordCall(node);
    } else if (ts.isForOfStatement(node)) {
      // Each member is bound to the loop variable in turn, which may change it.
      change(node.expression, [EVERY], false);
      if (!ts.isVariableDeclarationList(node.initializer)) assigned(node.initializer);
    } else if (ts.isForInStatement(node) && !ts.isVariableDeclarationList(node.initializer)) {
      assigned(node.initializer);
    } else if (ts.isTaggedTemplateExpression(node) && ts.isTemplateExpression(node.template)) {
      for (const span of node.template.templateSpans) change(span.expression, [], false);
    }
    if (isEntry(node)) entry = node.expression;
    ts.forEachChild(node, visit);
  }
  for (const file of program.getSourceFiles()) {
    if (program.getSyntacticDiagnostics(file).length > 0) limited = true;
    else visit(file);
  }

  const memo = new Map<ts.Node, Value>();
  const resolving = new Set<ts.Symbol>();
  const calling = new Set<ts.Symbol>();
  let evaluations = 0;
  function resolveSymbol(symbol: ts.Symbol | undefined, node: ts.Node, depth: number): Value {
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    const binding = declaration && constant(declaration);
    if (!symbol || !binding || overwhelmed || resolving.has(symbol)) return unknown(node);
    resolving.add(symbol);
    let value = resolve(binding.initializer, depth + 1);
    for (const step of binding.steps) value = destructured(value, step, depth);
    resolving.delete(symbol);
    for (const { path, replaced } of changes.get(symbol)?.values() ?? [])
      value = withChange(value, path, replaced, node);
    return value;
  }
  /** The member a destructuring step takes, or its default when that member is not set. */
  function destructured(value: Value, step: ts.BindingElement, depth: number): Value {
    const key = bindingKey(step);
    if (key === undefined) return unknown(step.name);
    const taken = property(value, key);
    return taken.kind === "missing" && step.initializer
      ? resolve(step.initializer, depth + 1)
      : taken;
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
    const literal = literalValue(node);
    if (literal !== undefined) return scalar(literal, node);
    if (isWrapper(node)) return resolve(node.expression, depth + 1);
    if (ts.isIdentifier(node)) return resolveSymbol(symbolFor(node), node, depth);
    if (ts.isShorthandPropertyAssignment(node))
      return resolveSymbol(checker.getShorthandAssignmentValueSymbol(node), node, depth);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      return lookup(node, depth);
    if (ts.isObjectLiteralExpression(node)) return evaluateObject(node, depth);
    if (ts.isArrayLiteralExpression(node)) {
      if (node.elements.some(ts.isSpreadElement)) return unknown(node);
      return { kind: "array", items: node.elements.map((item) => resolve(item, depth + 1)), node };
    }
    if (ts.isConditionalExpression(node))
      return either(node, [resolve(node.whenTrue, depth + 1), resolve(node.whenFalse, depth + 1)]);
    if (ts.isCallExpression(node)) return returned(node, depth);
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    )
      return evaluateDefault(node, depth);
    return evaluateText(node, depth);
  }
  /**
   * A lookup on a runtime value is itself the runtime value, so `ctx.event.payload.body` stays
   * that whole expression rather than collapsing to the `ctx` it starts from.
   */
  function lookup(
    node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    depth: number,
  ): Value {
    const base = resolve(node.expression, depth + 1);
    const key = ts.isPropertyAccessExpression(node)
      ? scalar(node.name.text, node.name)
      : resolve(node.argumentExpression, depth + 1);
    if (key.kind !== "scalar") return unknown(node);
    const value = property(base, String(key.value));
    return value.kind === "unknown" ? unknown(node) : value;
  }
  /** `left ?? right` and `left || right`: each way the left comes out stands or gives way. */
  function evaluateDefault(node: ts.BinaryExpression, depth: number): Value {
    const left = resolve(node.left, depth + 1);
    if (left.kind === "unknown") return unknown(node);
    const options = left.kind === "choice" ? left.options : [left];
    const kept = options.filter((option) => !givesWay(option, node.operatorToken.kind));
    if (kept.length === options.length) return left;
    return either(node, [...kept, resolve(node.right, depth + 1)]);
  }
  /**
   * What a call to a local function evaluates to, when every way out of it returns a value the
   * code fixes: `return ctx.event.source === "manual" ? "recovery" : "review"`. Its parameters
   * stay unknown, so a value built from them stays a runtime value. An object never leaves the
   * call, since the caller may change it.
   */
  function returned(node: ts.CallExpression, depth: number): Value {
    const callee = node.expression;
    const symbol = ts.isIdentifier(callee) ? symbolFor(callee) : undefined;
    const fn = symbol && callable(symbol);
    if (
      !symbol ||
      !fn ||
      fn.asteriskToken ||
      ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Async ||
      calling.has(symbol) ||
      [...(changes.get(symbol)?.values() ?? [])].some(
        (recorded) => recorded.replaced && recorded.path.length === 0,
      )
    )
      return unknown(node);
    const { results, complete } = exits(fn);
    if (!complete || results.length === 0) return unknown(node);
    calling.add(symbol);
    const value = either(
      node,
      results.map((result) => (result ? resolve(result, depth + 1) : MISSING)),
    );
    calling.delete(symbol);
    return immutable(value) ? value : unknown(node);
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
    let dynamic: ts.Node | null = null;
    for (const item of node.properties) {
      if (ts.isSpreadAssignment(item)) {
        const spread = resolve(item.expression, depth + 1);
        if (spread.kind !== "object" || spread.dynamic) {
          // Unread keys may override anything before them. With two such spreads, only the
          // literal as a whole says where a missing key comes from.
          properties.clear();
          const source = spread.kind === "object" ? spread.dynamic : item.expression;
          dynamic = dynamic ? node : source;
        }
        if (spread.kind === "object")
          spread.properties.forEach((value, key) => properties.set(key, value));
        continue;
      }
      const key = ts.isComputedPropertyName(item.name)
        ? resolve(item.name.expression, depth + 1)
        : scalar(propertyKey(item.name) ?? item.name.getText(), item.name);
      if (key.kind !== "scalar") {
        properties.clear();
        dynamic = node;
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
      return { status: "unset", value: null, values: [], expression: null, source: null };
    const source = location(value.node);
    if (value.kind === "scalar")
      return {
        status: "known",
        value: value.value === null ? null : preview(String(value.value)),
        values: [],
        expression: null,
        source,
      };
    const values = value.kind === "choice" ? named(value.options) : undefined;
    return {
      status: values ? "choice" : "runtime",
      value: null,
      values: values ?? [],
      expression: expression(value),
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

function unknown(node: ts.Node, path: readonly string[] = []): Value {
  return { kind: "unknown", node, path };
}

function scalar(value: string | number | boolean | null, node: ts.Node): Value {
  return { kind: "scalar", value, node };
}

function literalValue(node: ts.Node): string | number | boolean | null | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  return undefined;
}

function isWrapper(node: ts.Node): node is Wrapper {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAwaitExpression(node)
  );
}

function skip(node: ts.Expression): ts.Expression {
  return isWrapper(node) ? skip(node.expression) : node;
}

function isAssignment(operator: ts.SyntaxKind): boolean {
  return operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment;
}

function isStep(node: ts.Node): node is ts.PrefixUnaryExpression | ts.PostfixUnaryExpression {
  return (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

/** A key the code writes as a literal: `["agent"]`, `[0]`. */
function literalKey(node: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  return ts.isNumericLiteral(node) ? String(Number(node.text)) : undefined;
}

function propertyKey(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  return literalKey(ts.isComputedPropertyName(name) ? name.expression : name);
}

/** The key a destructuring element takes from what it destructures. */
function bindingKey(element: ts.BindingElement): string | undefined {
  if (element.dotDotDotToken) return undefined;
  if (ts.isArrayBindingPattern(element.parent))
    return String(element.parent.elements.indexOf(element));
  const name = element.propertyName ?? element.name;
  return ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)
    ? undefined
    : propertyKey(name);
}

/** The expression a literal member holds, if it holds one rather than a method. */
function memberValue(item: ts.ObjectLiteralElementLike | ts.Expression): ts.Expression | undefined {
  if (ts.isPropertyAssignment(item)) return item.initializer;
  if (ts.isShorthandPropertyAssignment(item)) return item.name;
  if (
    ts.isMethodDeclaration(item) ||
    ts.isGetAccessorDeclaration(item) ||
    ts.isSetAccessorDeclaration(item) ||
    ts.isSpreadAssignment(item) ||
    ts.isSpreadElement(item) ||
    ts.isOmittedExpression(item)
  )
    return undefined;
  return item;
}

function memberName(item: ts.ObjectLiteralElementLike | ts.Expression): string | undefined {
  return ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)
    ? propertyKey(item.name)
    : undefined;
}

/**
 * Every expression a declared name may take its value from, with the keys followed into each:
 * `const { agent = fallback } = policy` takes `policy.agent`, or `fallback`.
 */
function origins(declaration: ts.Node | undefined): Origin[] {
  if (declaration && (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)))
    return declaration.initializer
      ? [{ node: declaration.initializer, path: [], exact: true }]
      : [];
  if (!declaration || !ts.isBindingElement(declaration)) return [];
  const key = bindingKey(declaration);
  const found = origins(declaration.parent.parent).map(
    (origin): Origin =>
      origin.exact && key !== undefined
        ? { node: origin.node, path: [...origin.path, key], exact: true }
        : { node: origin.node, path: origin.path, exact: false },
  );
  if (declaration.initializer) found.push({ node: declaration.initializer, path: [], exact: true });
  return found;
}

/**
 * The `const` declaration a name is bound by, and the destructuring steps from its initializer to
 * the name. Anything else can be rebound, so its value is not read from the code.
 */
function constant(
  declaration: ts.Declaration,
): { initializer: ts.Expression; steps: ts.BindingElement[] } | undefined {
  const steps: ts.BindingElement[] = [];
  let current: ts.Node = declaration;
  while (ts.isBindingElement(current)) {
    steps.unshift(current);
    current = current.parent.parent;
  }
  if (
    !ts.isVariableDeclaration(current) ||
    !(current.parent.flags & ts.NodeFlags.Const) ||
    !current.initializer
  )
    return undefined;
  return { initializer: current.initializer, steps };
}

/** The function a name is bound to, when its body is in the code and the name cannot be rebound. */
function callable(symbol: ts.Symbol): Callable | undefined {
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isFunctionDeclaration(declaration) && declaration.body) return declaration;
    const initializer =
      ts.isVariableDeclaration(declaration) &&
      declaration.parent.flags & ts.NodeFlags.Const &&
      declaration.initializer
        ? skip(declaration.initializer)
        : undefined;
    if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)))
      return initializer;
  }
  return undefined;
}

/** What each `return` in a function hands back, and whether no way out runs off its end. */
function exits(fn: Callable): { results: (ts.Expression | undefined)[]; complete: boolean } {
  if (!fn.body) return { results: [], complete: false };
  if (!ts.isBlock(fn.body)) return { results: [fn.body], complete: true };
  const results: (ts.Expression | undefined)[] = [];
  const collect = (node: ts.Node): void => {
    // A nested function's `return` belongs to that function.
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isReturnStatement(node)) results.push(node.expression);
    ts.forEachChild(node, collect);
  };
  ts.forEachChild(fn.body, collect);
  const last = fn.body.statements.at(-1);
  return {
    results,
    complete: last !== undefined && (ts.isReturnStatement(last) || ts.isThrowStatement(last)),
  };
}

/** Whether nothing the code does can change the value in place. */
function immutable(value: Value): boolean {
  if (value.kind === "choice") return value.options.every(immutable);
  return value.kind === "scalar" || value.kind === "missing";
}

/** Whether `??` or `||` passes over a value to its right side. */
function givesWay(value: Value, operator: ts.SyntaxKind): boolean {
  if (value.kind === "missing") return true;
  if (value.kind !== "scalar") return false;
  return operator === ts.SyntaxKind.BarBarToken ? !value.value : value.value === null;
}

/**
 * A value that is one of `options`. A choice only holds values the code fixes, so a single option
 * it cannot read, or one that leaves the setting out, makes the whole value a runtime value.
 */
function either(node: ts.Node, options: readonly Value[]): Value {
  const flat: Value[] = [];
  for (const option of options) {
    if (option.kind === "unknown" || option.kind === "missing") return unknown(node);
    for (const item of option.kind === "choice" ? option.options : [option]) {
      if (!flat.some((seen) => same(seen, item))) flat.push(item);
    }
  }
  const [only, ...others] = flat;
  if (!only) return unknown(node);
  return others.length === 0 ? only : { kind: "choice", options: flat, node };
}

function same(left: Value, right: Value): boolean {
  return (
    left === right ||
    (left.kind === "scalar" && right.kind === "scalar" && left.value === right.value)
  );
}

function property(value: Value, key: string): Value {
  switch (value.kind) {
    case "object":
      return value.properties.get(key) ?? (value.dynamic ? unknown(value.dynamic, [key]) : MISSING);
    case "array":
      return /^(?:0|[1-9]\d*)$/u.test(key) ? (value.items[Number(key)] ?? MISSING) : MISSING;
    case "choice":
      return either(
        value.node,
        value.options.map((option) => property(option, key)),
      );
    case "unknown":
      return unknown(value.node, [...value.path, key]);
    default:
      return MISSING;
  }
}

/**
 * The value a binding holds once the code has made a change at `path` inside it. Whatever the change
 * reaches becomes a runtime value, read through `node` and the keys taken to get there.
 */
function withChange(
  value: Value,
  path: readonly string[],
  replaced: boolean,
  node: ts.Node,
  at: readonly string[] = [],
): Value {
  if (value.kind === "choice") {
    const result = either(
      value.node,
      value.options.map((option) => withChange(option, path, replaced, node, at)),
    );
    return result.kind === "unknown" ? unknown(node, at) : result;
  }
  if (path.length === 0) return replaced || !immutable(value) ? unknown(node, at) : value;
  const [key = EVERY, ...rest] = path;
  if (value.kind === "object") {
    const properties = new Map(value.properties);
    for (const name of key === EVERY ? value.properties.keys() : [key]) {
      const current = value.properties.get(name);
      const next = withChange(current ?? MISSING, rest, replaced, node, [...at, name]);
      // An unread spread may still supply a key the change leaves unset.
      if (current !== undefined || next.kind !== "missing") properties.set(name, next);
    }
    return { kind: "object", properties, dynamic: value.dynamic, node: value.node };
  }
  if (value.kind !== "array") return value;
  if (key === EVERY)
    return {
      kind: "array",
      items: value.items.map((item, index) =>
        withChange(item, rest, replaced, node, [...at, String(index)]),
      ),
      node: value.node,
    };
  const index = /^(?:0|[1-9]\d*)$/u.test(key) ? Number(key) : value.items.length;
  const item = value.items[index];
  // Writing past the end, or to `length`, changes which members the array has.
  if (item === undefined) return replaced ? unknown(node, at) : value;
  const items = [...value.items];
  items[index] = withChange(item, rest, replaced, node, [...at, key]);
  return { kind: "array", items, node: value.node };
}

/** The values a choice picks between, when each is a name or number the code fixes. */
function named(options: readonly Value[]): string[] | undefined {
  const values: string[] = [];
  for (const option of options) {
    if (option.kind !== "scalar" || option.value === null) return undefined;
    values.push(preview(String(option.value)));
  }
  return values;
}

/** The code that computes a value when the workflow runs, as it reads in the source. */
function expression(value: Exclude<Value, { kind: "missing" }>): string {
  const text = value.node.getText();
  if (value.kind !== "unknown" || value.path.length === 0) return text.slice(0, 1000);
  const node = value.node;
  const plain =
    ts.isIdentifier(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isCallExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isShorthandPropertyAssignment(node);
  return ((plain ? text : `(${text})`) + value.path.map(accessor).join("")).slice(0, 1000);
}

function accessor(key: string): string {
  if (/^[A-Za-z_$][\w$]*$/u.test(key)) return `.${key}`;
  return /^(?:0|[1-9]\d*)$/u.test(key) ? `[${key}]` : `[${JSON.stringify(key)}]`;
}

function preview(value: string): string {
  return value.length <= 16_000 ? value : value.slice(0, 16_000) + "\n… Preview truncated.";
}
