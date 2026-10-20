import { makePatternTool, elliottLabels } from './pattern-common';

export const elliottImpulse = makePatternTool({
  type: 'elliott-impulse',
  name: 'Elliott impulse (5-wave)',
  count: 6,
  defaults: { lineColor: '#089981', textColor: '#089981', degree: 'minor' },
  elliott: true,
  spec: {
    labels: (s) => elliottLabels(s, ['0', '1', '2', '3', '4', '5']),
  },
});
