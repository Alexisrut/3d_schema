#!/usr/bin/env node
/**
 * Запуск .test.ts из каталога tests без сети и без установки tsx.
 *
 * esbuild уже лежит в node_modules (его тянет vite), поэтому TypeScript
 * снимается им же: каждый тест собирается в один js-бандл во временный
 * каталог и выполняется обычным node. Так тесты работают на машине, где
 * `npm install` выполнить нельзя.
 *
 * Запуск:  node tests/run.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const esbuild = join(root, 'node_modules', '.bin', 'esbuild')
const outDir = join(tmpdir(), 'monitoring-tests')

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const tests = readdirSync(here)
  .filter((f) => f.endsWith('.test.ts'))
  .sort()

if (tests.length === 0) {
  console.error('Не найдено ни одного *.test.ts')
  process.exit(1)
}

let failed = 0

for (const test of tests) {
  const bundle = join(outDir, test.replace(/\.test\.ts$/, '.mjs'))
  try {
    execFileSync(
      esbuild,
      [
        join(here, test),
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--target=node18',
        // node:assert и прочие встроенные модули оставляем внешними
        '--external:node:*',
        `--outfile=${bundle}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
    )
  } catch (error) {
    failed += 1
    console.error(`\n✗ ${test}: не удалось собрать`)
    console.error(`${error.stderr ?? error.message}`)
    continue
  }

  try {
    const output = execFileSync(process.execPath, [bundle], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    })
    process.stdout.write(output)
  } catch (error) {
    failed += 1
    process.stdout.write(`${error.stdout ?? ''}`)
    process.stderr.write(`${error.stderr ?? ''}`)
    console.error(`✗ ${test}: тесты провалены`)
  }
}

rmSync(outDir, { recursive: true, force: true })

if (failed > 0) {
  console.error(`\nПровалено файлов: ${failed}`)
  process.exit(1)
}
console.log('\nВсе файлы тестов пройдены.')
