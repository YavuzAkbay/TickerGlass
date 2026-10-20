import { makePatternTool, elliottLabels } from './pattern-common';

export const elliottTripleCombo = makePatternTool({
  type: 'elliott-triple-combo',
  name: 'Elliott triple combination',
  count: 6,
  defaults: { lineColor: '#089981', textColor: '#089981', degree: 'minor' },
  elliott: true,
  spec: {
    labels: (s) => elliottLabels(s, ['0', 'W', 'X', 'Y', 'X', 'Z']),
  },
});
