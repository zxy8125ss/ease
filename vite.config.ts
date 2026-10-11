import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { viteSingleFile } from 'vite-plugin-singlefile';

// PREVIEW=1 时打成单个 HTML（用于预览），默认构建为 GitHub Pages 的 PWA
const preview = process.env.PREVIEW === '1';

export default defineConfig({
  base: preview ? './' : '/ease/',
  plugins: [
    react(),
    preview
      ? viteSingleFile()
      : VitePWA({
          registerType: 'autoUpdate',
          includeAssets: ['apple-touch-icon-v2.png'],
          manifest: {
            name: 'Ease',
            short_name: 'Ease',
            description: '轮班女性的轻量体重管理助手',
            lang: 'zh-CN',
            theme_color: '#F2EADF',
            background_color: '#F2EADF',
            display: 'standalone',
            start_url: '/ease/',
            scope: '/ease/',
            icons: [
              { src: 'icon-192-v2.png', sizes: '192x192', type: 'image/png' },
              { src: 'icon-512-v2.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
            ],
          },
        }),
  ],
  build: { outDir: preview ? 'dist-preview' : 'dist' },
});
