import { makePatternTool, elliottLabels } from './pattern-common';

export const elliottTriangle = makePatternTool({
  type: 'elliott-triangle',
  name: 'Elliott triangle (5-wave)',
  count: 6,
  defaults: { lineColor: '#7FB069', textColor: '#7FB069', degree: 'minor' },
  elliott: true,
  spec: {
    labels: (s) => elliottLabels(s, ['0', 'A', 'B', 'C', 'D', 'E']),
  },
});
