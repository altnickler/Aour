import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath } from 'node:url'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['icons/favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Aour — your happy hours, ranked',
        short_name: 'Aour',
        description: 'Discover, rate and rank the best happy hours near you.',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#FFF9EC',
        theme_color: '#FFF9EC',
        categories: ['food', 'lifestyle', 'social'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The map library is large and only needed on the Map screen: cache it on first use instead.
        globIgnores: ['**/maplibre-*.js', '**/og.png'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Public listing photos & avatars from Supabase Storage.
            urlPattern: ({ url }) => url.pathname.startsWith('/storage/v1/object/public/'),
            handler: 'CacheFirst',
            options: { cacheName: 'images', expiration: { maxEntries: 300, maxAgeSeconds: 30 * 86400 } },
          },
          {
            urlPattern: ({ url }) => /\/assets\/maplibre-.*\.js$/.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'maplibre', expiration: { maxEntries: 4 } },
          },
          {
            urlPattern: ({ url }) => url.hostname === 'tiles.openfreemap.org',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'map', expiration: { maxEntries: 500, maxAgeSeconds: 7 * 86400 } },
          },
        ],
      },
    }),
  ],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('maplibre-gl')) return 'maplibre'
          if (id.includes('@supabase')) return 'supabase'
          if (id.includes('node_modules/react') || id.includes('react-router') || id.includes('@tanstack')) return 'vendor'
        },
      },
    },
  },
  server: { host: true },
})
