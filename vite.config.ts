import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // private/ is git-ignored (owner's real data); its tests run only where the folder exists.
    include: ['src/**/*.test.{ts,tsx}', 'private/**/*.test.ts'],
  },
})
