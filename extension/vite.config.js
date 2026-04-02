import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { cpSync } from 'fs'

export default defineConfig(({ mode }) => {
  // "content" mode builds the content script as a standalone IIFE
  if (mode === 'content') {
    return {
      build: {
        emptyOutDir: false,
        outDir: 'dist',
        lib: {
          entry: resolve(__dirname, 'src/content/content.js'),
          name: 'chessbot',
          formats: ['iife'],
          fileName: () => 'content/content.js',
        },
        rollupOptions: {
          output: { extend: true },
        },
      },
    }
  }

  // Default mode builds the popup (React)
  return {
    plugins: [react()],
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: { popup: resolve(__dirname, 'index.html') },
      },
    },
  }
})
