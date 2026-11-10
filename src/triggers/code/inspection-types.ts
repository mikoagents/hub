export interface SourceLocation {
  path: string;
  line: number;
  column: number;
  endLine: number;
}

export interface CodeField {
  status: "known" | "runtime" | "unset";
  value: string | null;
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
