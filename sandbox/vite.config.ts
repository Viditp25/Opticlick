import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH ?? '/',
  define: {
    // Expose PR metadata baked in at build time
    'import.meta.env.VITE_PR_NUMBER': JSON.stringify(process.env.VITE_PR_NUMBER ?? ''),
    'import.meta.env.VITE_BRANCH_NAME': JSON.stringify(process.env.VITE_BRANCH_NAME ?? ''),
    'import.meta.env.VITE_LANGSMITH_TRACING': JSON.stringify(process.env.VITE_LANGSMITH_TRACING ?? ''),
    'import.meta.env.VITE_LANGSMITH_ENDPOINT': JSON.stringify(process.env.VITE_LANGSMITH_ENDPOINT ?? ''),
    'import.meta.env.VITE_LANGSMITH_API_KEY': JSON.stringify(process.env.VITE_LANGSMITH_API_KEY ?? ''),
    'import.meta.env.VITE_LANGSMITH_PROJECT': JSON.stringify(process.env.VITE_LANGSMITH_PROJECT ?? ''),
  },
  resolve: {
    alias: [
      // Override CDP-heavy modules with sandbox-safe equivalents
      {
        find: '@/utils/cdp',
        replacement: path.resolve(__dirname, 'src/chrome-mock/debugger.ts'),
      },
      {
        find: '@/utils/tab-helpers',
        replacement: path.resolve(__dirname, 'src/chrome-mock/messaging.ts'),
      },
      // Map all other @/ imports to the real extension source
      {
        find: '@/',
        replacement: path.resolve(__dirname, '../src/') + '/',
      },
    ],
  },
  optimizeDeps: {
    include: [
      'react', 'react-dom',
      'html2canvas',
      '@langchain/core',
      '@langchain/google-genai',
      '@langchain/anthropic',
      '@langchain/openai',
      '@langchain/langgraph',
    ],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      external: [],
    },
  },
  server: {
    port: 5174,
  },
}));
