/**
 * 测试总入口：依次跑 test/ 下所有 *.test.mjs，最后汇总。
 *
 *   node test/all.mjs
 *
 * 用 spawnSync + stdio:'inherit'（不经过管道），因此在受限环境里也能用。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(HERE).filter((f) => f.endsWith('.test.mjs')).sort()

if (files.length === 0) {
  console.error('没有找到任何 *.test.mjs')
  process.exit(1)
}

const failed = []
const started = Date.now()

for (const file of files) {
  console.log(`\n──────── ${file} ────────`)
  const result = spawnSync(process.execPath, [join(HERE, file)], { stdio: 'inherit' })
  if (result.status !== 0) failed.push(file)
}

const seconds = ((Date.now() - started) / 1000).toFixed(1)
console.log('\n' + '='.repeat(52))
if (failed.length === 0) {
  console.log(`✅ 全部通过（${files.length} 个文件，${seconds}s）`)
} else {
  console.log(`❌ 失败的测试文件（${failed.length}/${files.length}）：`)
  for (const f of failed) console.log('   - ' + f)
}
process.exit(failed.length === 0 ? 0 : 1)
