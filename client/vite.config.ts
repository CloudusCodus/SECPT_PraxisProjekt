import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite configuration enabling React support and custom server port.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true
  },
  preview: {
    port: 4173,
    host: true
  }
});