import { makePatternTool } from './pattern-common';

export const trianglePattern = makePatternTool({
  type: 'triangle-pattern',
  name: 'Triangle pattern',
  count: 4,
  defaults: { fillBackground: false },
  spec: {
    labels: () => ['A', 'B', 'C', 'D'],
    // Converging trend lines A-C and B-D.
    lines: [
      [0, 2],
      [1, 3],
    ],
  },
});
