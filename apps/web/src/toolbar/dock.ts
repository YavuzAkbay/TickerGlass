/**
 * The drawing dock: five task-based categories built from the tool catalog
 * (`TOOL_GROUPS`), plus the quick-tools defaults. A category lists whole
 * sections of one or more catalog groups; tools keep their catalog group for
 * last-used memory and highlighting.
 */
import * as I from './icons';
import type { ToolIcon } from './icons';
import {
  findTool,
  groupOf,
  ICONS_GROUP_ID,
  isToolAvailable,
  MEASURE_TOOL,
  TOOL_GROUPS,
  ZOOM_TOOL,
  type ToolDef,
  type ToolSection,
} from './tools';

export interface DockCategory {
  id: string;
  label: string;
  icon: ToolIcon;
  sections: ToolSection[];
  /** Catalog groups whose active tool lights this category up. */
  groups: string[];
  /** Also lists the sticker and emoji grid. */
  stickers?: boolean;
}

const sectionsOf = (groupId: string): ToolSection[] =>
  TOOL_GROUPS.find((g) => g.id === groupId)?.sections ?? [];

export const DOCK_CATEGORIES: DockCategory[] = [
  {
    id: 'lines',
    label: 'Lines',
    icon: I.IconTrendLine,
    sections: sectionsOf('lines'),
    groups: ['lines'],
  },
  {
    id: 'shapes',
    label: 'Shapes',
    icon: I.IconRectangle,
    sections: sectionsOf('shapes'),
    groups: ['shapes'],
  },
  {
    id: 'text',
    label: 'Text',
    icon: I.IconText,
    sections: sectionsOf('annotation'),
    groups: ['annotation', ICONS_GROUP_ID],
    stickers: true,
  },
  {
    id: 'measure',
    label: 'Measure',
    icon: I.IconRuler,
    sections: [
      { title: 'Navigate', tools: [MEASURE_TOOL, ZOOM_TOOL] },
      ...sectionsOf('forecasting'),
      ...sectionsOf('fib'),
    ],
    groups: ['forecasting', 'fib', 'measure', 'zoom'],
  },
  {
    id: 'patterns',
    label: 'Patterns',
    icon: I.IconXabcd,
    sections: sectionsOf('patterns'),
    groups: ['patterns'],
  },
];

/** Dock category a tool lives in (none for cursors). */
export function categoryOf(toolId: string): DockCategory | undefined {
  const group = groupOf(toolId);
  return group ? DOCK_CATEGORIES.find((c) => c.groups.includes(group)) : undefined;
}

/** Every dock tool, in dock order. */
export function dockTools(): ToolDef[] {
  return DOCK_CATEGORIES.flatMap((c) => c.sections.flatMap((s) => s.tools));
}

/** Case-insensitive match on any word start of the name ("fib re", "rect"). */
export function matchesTool(tool: ToolDef, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const name = tool.name.toLowerCase();
  return (
    name.includes(q) ||
    q.split(/\s+/).every((w) => name.split(/[^a-z0-9]+/).some((n) => n.startsWith(w)))
  );
}

/** Sections of `category` filtered by `query`; empty sections are dropped. */
export function filterSections(sections: ToolSection[], query: string): ToolSection[] {
  return sections
    .map((s) => ({ ...s, tools: s.tools.filter((t) => matchesTool(t, query)) }))
    .filter((s) => s.tools.length > 0);
}

/** Tools the quick menu offers before anything is starred. */
export const QUICK_DEFAULTS = [
  'trend-line',
  'horizontal-line',
  'ray',
  'parallel-channel',
  'fib-retracement',
  'rectangle',
  'text',
  'long-position',
];

/** Favorites, else the defaults; only tools that exist in this build. */
export function quickTools(favorites: readonly string[]): ToolDef[] {
  const ids = favorites.length ? favorites : QUICK_DEFAULTS;
  return ids.flatMap((id) => {
    const tool = findTool(id);
    return tool && isToolAvailable(id) ? [tool] : [];
  });
}
