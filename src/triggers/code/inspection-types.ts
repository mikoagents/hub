export interface SourceLocation {
  path: string;
  line: number;
  column: number;
  endLine: number;
}

export interface CodeField {
  /**
   * `known` is fixed in the code. `choice` is one of `values`, picked when the workflow runs —
   * `ctx.event.source === "manual" ? "recovery" : "review"`. `runtime` is computed by
   * `expression`, and `unset` is left out for the default to apply.
   */
  status: "known" | "choice" | "runtime" | "unset";
  value: string | null;
  /** The values a `choice` picks between; empty for every other status. */
  values: string[];
  expression: string | null;
  source: SourceLocation | null;
}

export interface InspectedAgent {
  source: SourceLocation;
  id: CodeField;
  target: CodeField;
  provider: CodeField;
  model: CodeField;
  mode: CodeField;
  thinking: CodeField;
  prompt: CodeField;
  github: CodeField;
  maxRuntime: CodeField;
  idleTimeout: CodeField;
  startupTimeout: CodeField;
}

export interface TriggerInspection {
  agents: InspectedAgent[];
  locations: {
    entry: SourceLocation | null;
    events: SourceLocation | null;
    targets: SourceLocation | null;
    github: SourceLocation | null;
  };
  limited: boolean;
}
