import { makePatternTool } from './pattern-common';

export const abcd = makePatternTool({
  type: 'abcd',
  name: 'ABCD pattern',
  count: 4,
  spec: {
    labels: () => ['A', 'B', 'C', 'D'],
    ratios: [
      { from: 0, to: 2, num: [1, 2], den: [0, 1] },
      { from: 1, to: 3, num: [2, 3], den: [1, 2] },
    ],
  },
});
