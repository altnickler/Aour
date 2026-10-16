import { defineConfig, loadEnv, type Plugin } from 'vite'
import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath } from 'node:url'
import pkg from './package.json' with { type: 'json' }

function git(cmd: string): string | null {
  try {
    return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null
  } catch {
    return null
  }
}

/**
 * Publishes /version.json so anyone can tell which commit is deployed and whether the build
 * talks to Supabase or runs in demo mode. Contains nothing secret (no URLs or keys).
 * Commit/branch come from Cloudflare Workers Builds, GitHub Actions, or the local git checkout.
 */
function versionFile(env: Record<string, string>): Plugin {
  const backend = env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY ? 'supabase' : 'demo'
  const info = {
    version: pkg.version,
    commit: process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA || git('rev-parse HEAD'),
    branch: process.env.WORKERS_CI_BRANCH || process.env.GITHUB_REF_NAME || git('rev-parse --abbrev-ref HEAD'),
    builtAt: new Date().toISOString(),
    builtBy: process.env.WORKERS_CI ? 'cloudflare-workers-builds' : process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
    backend,
  }
  return {
    name: 'aour-version-file',
    apply: 'build',
    buildStart() {
      if (backend === 'demo' && (process.env.WORKERS_CI || process.env.CF_PAGES)) {
        this.warn(
          'VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set for this Cloudflare build. ' +
            'The deployed app will refuse to run demo mode on a public hostname and will show a "not configured" screen. ' +
            'Add both as build variables (Workers → Settings → Build → Variables and secrets).',
        )
      }
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(info, null, 2) })
    },
  }
}

export default defineConfig(({ mode }) => ({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [
    versionFile(loadEnv(mode, process.cwd(), 'VITE_')),
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
}))
