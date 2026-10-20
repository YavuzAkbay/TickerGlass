import { makePatternTool, elliottLabels } from './pattern-common';

export const elliottTriangle = makePatternTool({
  type: 'elliott-triangle',
  name: 'Elliott triangle (5-wave)',
  count: 6,
  defaults: { lineColor: '#18a383', textColor: '#18a383', degree: 'minor' },
  elliott: true,
  spec: {
    labels: (s) => elliottLabels(s, ['0', 'A', 'B', 'C', 'D', 'E']),
  },
});
