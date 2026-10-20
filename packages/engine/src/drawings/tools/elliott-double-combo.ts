import { makePatternTool, elliottLabels } from './pattern-common';

export const elliottDoubleCombo = makePatternTool({
  type: 'elliott-double-combo',
  name: 'Elliott double combination',
  count: 4,
  defaults: { lineColor: '#089981', textColor: '#089981', degree: 'minor' },
  elliott: true,
  spec: {
    labels: (s) => elliottLabels(s, ['0', 'W', 'X', 'Y']),
  },
});
