import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  // Served from https://shme14.github.io/garage-log/
  base: '/garage-log/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'Garage Log',
        short_name: 'Garage',
        description: 'Date- and km-stamped maintenance notes for vehicles and bikes',
        display: 'standalone',
        start_url: '/garage-log/',
        scope: '/garage-log/',
        // --surface (header) and --bg in src/ui/styles.css, light theme
        theme_color: '#ffffff',
        background_color: '#f4f5f7',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // Precache the app shell only. There is deliberately no runtimeCaching, so requests to
      // accounts.google.com / googleapis.com always go straight to the network.
      workbox: {
        navigateFallback: '/garage-log/index.html',
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // private/ is git-ignored (owner's real data); its tests run only where the folder exists.
    include: ['src/**/*.test.{ts,tsx}', 'private/**/*.test.ts'],
  },
})
