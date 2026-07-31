import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const BACKEND = process.env.VITE_BACKEND_URL ?? 'http://127.0.0.1:8000'

/** Общий проксёр для dev-сервера и предпросмотра собранного бандла. */
const PROXY = {
  '/api': { target: BACKEND, changeOrigin: true },
  '/media': { target: BACKEND, changeOrigin: true },
  '/ws': { target: BACKEND, ws: true, changeOrigin: true },
}

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          // Компоненты TresJS (<TresMesh>, <TresPerspectiveCamera>, <primitive>)
          // обрабатывает собственный рендерер библиотеки — Vue не должен пытаться
          // резолвить их как обычные компоненты. Исключение — сам <TresCanvas>,
          // это настоящий Vue-компонент, который мы импортируем.
          isCustomElement: (tag) =>
            (tag.startsWith('Tres') && tag !== 'TresCanvas') || tag === 'primitive',
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: PROXY,
  },
  // Тот же проксёр для `vite preview`: собранный бандл надо уметь проверять
  // локально против настоящего бэкенда, а не только dev-сервер.
  preview: {
    port: 4173,
    proxy: PROXY,
  },
})
