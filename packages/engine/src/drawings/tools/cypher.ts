import { makePatternTool } from './pattern-common';

export const cypher = makePatternTool({
  type: 'cypher',
  name: 'Cypher pattern',
  count: 5,
  spec: {
    labels: () => ['X', 'A', 'B', 'C', 'D'],
    // B: AB/XA, C: XC/XA (extension of XA), D: CD/XC (retracement of XC).
    ratios: [
      { from: 0, to: 2, num: [1, 2], den: [0, 1] },
      { from: 1, to: 3, num: [0, 3], den: [0, 1] },
      { from: 0, to: 4, num: [3, 4], den: [0, 3] },
    ],
    fills: [
      [0, 1, 2],
      [2, 3, 4],
    ],
  },
});
