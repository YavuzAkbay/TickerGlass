import { makePatternTool, elliottLabels } from './pattern-common';

export const elliottTriangle = makePatternTool({
  type: 'elliott-triangle',
  name: 'Elliott triangle wave (ABCDE)',
  count: 6,
  defaults: { lineColor: '#089981', textColor: '#089981', degree: 'minor' },
  elliott: true,
  spec: {
    labels: (s) => elliottLabels(s, ['0', 'A', 'B', 'C', 'D', 'E']),
  },
});
