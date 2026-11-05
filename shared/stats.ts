// Rows of `pi stats --json`: `byModel` and `byProvider` entries name themselves in `name`
// (`anthropic/claude-opus-5-5`, `openai-codex`).
export interface StatsRow {
  name?: string;
  provider?: string;
  model?: string;
  sessions?: number;
  cost?: number;
  tokens?: { total?: number };
}

export function statsRowName(row: StatsRow): string {
  if (row.name) return row.name;
  if (row.provider && row.model) return `${row.provider}/${row.model}`;
  return row.model ?? row.provider ?? "unknown";
}
