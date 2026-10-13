import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.API_URL ?? 'http://localhost:8000';

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        // React (rarely changes) and the chart engine in their own chunks: each stays
        // under the 500 kB warning and caches independently of app code.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'engine', test: /packages[\\/]engine[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true },
    },
  },
});
