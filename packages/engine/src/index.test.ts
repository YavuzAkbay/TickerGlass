import { expect, it } from 'vitest';
import { ENGINE_VERSION } from './index';

it('exports a version', () => {
  expect(ENGINE_VERSION).toBe('0.0.0');
});
