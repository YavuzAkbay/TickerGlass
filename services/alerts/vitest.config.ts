import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // isolated-vm (user-script isolates) needs this flag on Node 20+ (its README); the test
    // workers are separate Node processes that would not inherit it.
    execArgv: ['--no-node-snapshot'],
  },
});
