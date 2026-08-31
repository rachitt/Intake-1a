import { defineConfig } from 'vite';

// A different port from Mock A on purpose: both run at once, so a run against
// one can never be mistaken for a run against the other.
export default defineConfig({
  server: {
    port: 5273,
    strictPort: true,
    open: false,
  },
});
