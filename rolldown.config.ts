import { defineConfig } from 'rolldown'

export default defineConfig({
  input: 'src/index.ts',
  platform: 'browser',
  output: { dir: 'dist', format: 'esm', sourcemap: true, minify: true },
})
