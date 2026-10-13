import type { AnyDrawingToolDefinition, DrawingStyle, DrawingToolDefinition } from './types';

const tools = new Map<string, AnyDrawingToolDefinition>();

/** Identity helper that infers the style type, so `render` etc. are typed. */
export function defineDrawingTool<S extends DrawingStyle>(
  def: DrawingToolDefinition<S>,
): DrawingToolDefinition<S> {
  return def;
}

/** Register (or replace) a tool. Built-ins register in drawings/tools/index.ts. */
export function registerDrawingTool<S extends DrawingStyle>(def: DrawingToolDefinition<S>): void {
  tools.set(def.type, def as unknown as AnyDrawingToolDefinition);
}

export function getDrawingTool(type: string): AnyDrawingToolDefinition | undefined {
  return tools.get(type);
}

/** All tools in registration order. */
export function listDrawingTools(): AnyDrawingToolDefinition[] {
  return [...tools.values()];
}
