/** What one chart tool did, as the model reads it (JSON) and the user sees it (a chip). */
export interface ToolResult {
  content: string;
  summary: string;
  ok: boolean;
}

export const MAX_RESULT_CHARS = 4000;

export function result(
  data: unknown,
  summary: string,
  ok = true,
  maxChars = MAX_RESULT_CHARS,
): ToolResult {
  let content = JSON.stringify(data);
  if (content.length > maxChars) content = `${content.slice(0, maxChars)}…`;
  return { content, summary, ok };
}

export const fail = (message: string, summary = message): ToolResult =>
  result({ error: message }, summary, false);

/** JSON without nulls (figures a source does not have). */
export function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(prune);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== null && x !== undefined)
        .map(([k, x]) => [k, prune(x)]),
    );
  return v;
}
