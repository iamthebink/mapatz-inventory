import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist/web' },
  server: { proxy: { '/api': `http://localhost:${process.env.PORT ?? 3000}` } },
});
