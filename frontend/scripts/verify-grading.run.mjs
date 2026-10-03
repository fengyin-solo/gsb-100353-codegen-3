// 分级判定台联调入口：用 esbuild 的 JS API 即时打包 TS 脚本后执行（兼容跨平台安装的 node_modules）。
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'verify-grading-'))
const outfile = join(dir, 'verify.cjs')
await build({
  entryPoints: ['scripts/verify-grading.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  logLevel: 'silent',
})
await import(pathToFileURL(outfile).href)
rmSync(dir, { recursive: true, force: true })
