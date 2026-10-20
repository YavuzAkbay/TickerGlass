import { makePatternTool, elliottLabels } from './pattern-common';

export const elliottCorrection = makePatternTool({
  type: 'elliott-correction',
  name: 'Elliott correction (3-wave)',
  count: 4,
  defaults: { lineColor: '#089981', textColor: '#089981', degree: 'minor' },
  elliott: true,
  spec: {
    labels: (s) => elliottLabels(s, ['0', 'A', 'B', 'C']),
  },
});
