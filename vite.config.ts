import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import {defineConfig} from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ command }) => {
  const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true' || !!process.env.VERCEL_URL;
  const explicitBase = process.env.VITE_BASE_PATH?.trim();
  const githubRepo = process.env.GITHUB_REPOSITORY?.trim();

  let basePath = '/';
  if (command === 'serve') {
    basePath = '/';
  } else if (explicitBase) {
    basePath = explicitBase === './' ? './' : `/${explicitBase.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
  } else if (isVercel) {
    basePath = '/';
  } else if (githubRepo && githubRepo.includes('/')) {
    const repoName = githubRepo.split('/')[1];
    basePath = repoName && !repoName.endsWith('.github.io') ? `/${repoName}/` : '/';
  } else {
    basePath = './';
  }

  const manifestBase = basePath === './' ? './' : basePath;

  return {
    base: basePath,
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: 'auto',
        workbox: {
          maximumFileSizeToCacheInBytes: 5000000,
          globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,json,xml,txt}'],
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: true,
          navigateFallback: command === 'build' ? 'index.html' : undefined,
          navigateFallbackDenylist: [/^\/__/, /\/api\//, /firebase-messaging-sw\.js$/, /OneSignalSDK.*\.js$/],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
                },
              },
            },
            {
              urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp|ico)$/i,
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'static-image-assets',
                expiration: {
                  maxEntries: 60,
                  maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
                },
              },
            },
            {
              // Dynamic cloud sync, Firebase Auth, Realtime DB, Firestore & OneSignal MUST bypass cache
              urlPattern: /^https:\/\/(?:.*\.firebaseio\.com|identitytoolkit\.googleapis\.com|firestore\.googleapis\.com|cdn\.onesignal\.com|onesignal\.com)\/.*/i,
              handler: 'NetworkOnly',
            },
          ],
        },
        devOptions: {
          enabled: false,
        },
        manifest: {
          id: manifestBase,
          name: 'HSS ALL IN ONE',
          short_name: 'HSS AllInOne',
          description: 'HSS ALL IN ONE is an educational resource platform for Higher Secondary students, providing study materials, notes, PDFs, question papers and useful academic resources.',
          theme_color: '#0F1115',
          background_color: '#0F1115',
          display: 'standalone',
          scope: manifestBase,
          start_url: manifestBase,
          orientation: 'portrait-primary',
          categories: ['education', 'productivity', 'utilities'],
          icons: [
            {
              src: 'favicon-16x16.png',
              sizes: '16x16',
              type: 'image/png'
            },
            {
              src: 'favicon-32x32.png',
              sizes: '32x32',
              type: 'image/png'
            },
            {
              src: 'favicon-48x48.png',
              sizes: '48x48',
              type: 'image/png'
            },
            {
              src: 'apple-touch-icon.png',
              sizes: '180x180',
              type: 'image/png'
            },
            {
              src: 'pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any'
            },
            {
              src: 'icon-192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any'
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any'
            },
            {
              src: 'icon-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any'
            },
            {
              src: 'pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable'
            },
            {
              src: 'icon-maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable'
            }
          ],
          shortcuts: [
            {
              name: 'Daily Attendance',
              short_name: 'Attendance',
              description: 'Mark attendance and generate absentee register',
              url: `${manifestBase}#attendance`,
              icons: [{ src: 'pwa-192x192.png', sizes: '192x192' }]
            },
            {
              name: 'Exam Marks & Ranks',
              short_name: 'Exams',
              description: 'Enter exam marks and compute ranks',
              url: `${manifestBase}#exams`,
              icons: [{ src: 'pwa-192x192.png', sizes: '192x192' }]
            },
            {
              name: 'Academic PDF Reports',
              short_name: 'Reports',
              description: 'Generate and download classroom PDF reports',
              url: `${manifestBase}#reports`,
              icons: [{ src: 'pwa-192x192.png', sizes: '192x192' }]
            },
            {
              name: 'School Admin Portal',
              short_name: 'School Admin',
              description: 'Institutional administrator dashboard',
              url: `${manifestBase}#school-admin`,
              icons: [{ src: 'pwa-192x192.png', sizes: '192x192' }]
            }
          ]
        }
      }),
      // Ensure SPA fallback works for deep links, subpaths, and refreshes on GitHub Pages
      {
        name: 'spa-fallback-plugin',
        closeBundle() {
          const distDir = path.resolve(__dirname, 'dist');
          const distIndex = path.resolve(distDir, 'index.html');
          const dist404 = path.resolve(distDir, '404.html');
          const distNoJekyll = path.resolve(distDir, '.nojekyll');
          if (fs.existsSync(distIndex)) {
            fs.copyFileSync(distIndex, dist404);
          }
          try {
            fs.writeFileSync(distNoJekyll, '');
          } catch (e) {}
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
