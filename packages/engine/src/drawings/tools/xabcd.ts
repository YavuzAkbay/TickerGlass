import { makePatternTool } from './pattern-common';

export const xabcd = makePatternTool({
  type: 'xabcd',
  name: 'XABCD pattern',
  count: 5,
  spec: {
    labels: () => ['X', 'A', 'B', 'C', 'D'],
    ratios: [
      { from: 0, to: 2, num: [1, 2], den: [0, 1] },
      { from: 1, to: 3, num: [2, 3], den: [1, 2] },
      { from: 2, to: 4, num: [3, 4], den: [2, 3] },
      { from: 0, to: 4, num: [1, 4], den: [0, 1] },
    ],
    fills: [
      [0, 1, 2],
      [2, 3, 4],
    ],
  },
});
