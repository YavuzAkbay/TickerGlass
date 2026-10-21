import { makePatternTool } from './pattern-common';

export const threeDrives = makePatternTool({
  type: 'three-drives',
  name: 'Three drives pattern',
  count: 7,
  spec: {
    labels: () => ['0', '1', 'A', '2', 'B', '3', 'C'],
    ratios: [
      { from: 0, to: 2, num: [1, 2], den: [0, 1] },
      { from: 1, to: 3, num: [2, 3], den: [1, 2] },
      { from: 2, to: 4, num: [3, 4], den: [2, 3] },
      { from: 3, to: 5, num: [4, 5], den: [3, 4] },
      { from: 4, to: 6, num: [5, 6], den: [4, 5] },
    ],
  },
});
