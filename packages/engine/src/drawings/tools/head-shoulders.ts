import { makePatternTool } from './pattern-common';

export const headShoulders = makePatternTool({
  type: 'head-shoulders',
  name: 'Head and shoulders',
  count: 7,
  spec: {
    labels: () => ['', 'Left Shoulder', '', 'Head', '', 'Right Shoulder', ''],
    neckline: [2, 4],
    fills: [
      [0, 1, 2],
      [2, 3, 4],
      [4, 5, 6],
    ],
  },
});
