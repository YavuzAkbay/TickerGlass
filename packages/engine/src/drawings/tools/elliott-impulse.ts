import { makePatternTool, elliottLabels } from './pattern-common';

export const elliottImpulse = makePatternTool({
  type: 'elliott-impulse',
  name: 'Elliott impulse (5-wave)',
  count: 6,
  defaults: { lineColor: '#7FB069', textColor: '#7FB069', degree: 'minor' },
  elliott: true,
  spec: {
    labels: (s) => elliottLabels(s, ['0', '1', '2', '3', '4', '5']),
  },
});
