#!/usr/bin/env node
/**
 * Статическая проверка .vue-файлов без установки зависимостей:
 *  1) синтаксис <script setup lang="ts"> — прогоняется через tsc;
 *  2) баланс тегов в <template> — простой токенайзер;
 *  3) наличие ровно одного корневого <template> и валидных блоков.
 *
 * Запуск:  node tests/check-sfc.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const srcDir = join(root, 'src')
// Каталог намеренно вне проекта: иначе tsc находит tsconfig.json выше по дереву
// и отказывается компилировать файлы, переданные аргументами (TS5112).
const tmpDir = join(tmpdir(), 'sfc-check')

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const problems = []

function extractBlock(source, tag) {
  const open = new RegExp(`<${tag}(\\s[^>]*)?>`, 'i')
  const match = open.exec(source)
  if (!match) return null
  const start = match.index + match[0].length
  const closeTag = `</${tag}>`
  const end = source.lastIndexOf(closeTag)
  if (end === -1 || end < start) return null
  return { content: source.slice(start, end), attrs: match[1] ?? '' }
}

/** Грубая, но действенная проверка баланса тегов внутри <template>. */
function checkTemplateBalance(file, template) {
  // Убираем комментарии и содержимое строковых атрибутов, чтобы '<' внутри
  // выражений (например, v-if="a < b") не ломал разбор.
  const cleaned = template
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''")

  const stack = []
  const tagRe = /<\/?([A-Za-z][-A-Za-z0-9_.]*)((?:[^<>])*?)(\/?)>/g
  let match
  while ((match = tagRe.exec(cleaned)) !== null) {
    const [full, name, , selfClose] = match
    const isClosing = full.startsWith('</')
    const lower = name.toLowerCase()

    if (isClosing) {
      const expected = stack.pop()
      if (expected === undefined) {
        problems.push(`${file}: закрывающий </${name}> без открывающего`)
        return
      }
      if (expected !== name) {
        problems.push(`${file}: ожидалось </${expected}>, встречено </${name}>`)
        return
      }
      continue
    }

    if (selfClose === '/' || VOID_TAGS.has(lower)) continue
    stack.push(name)
  }

  if (stack.length > 0) {
    problems.push(`${file}: незакрытые теги — ${stack.join(', ')}`)
  }
}

const vueFiles = walk(srcDir).filter((f) => f.endsWith('.vue'))
const tsFiles = walk(srcDir).filter((f) => f.endsWith('.ts'))

rmSync(tmpDir, { recursive: true, force: true })
mkdirSync(tmpDir, { recursive: true })

const generated = []

for (const file of vueFiles) {
  const rel = relative(root, file)
  const source = readFileSync(file, 'utf8')

  const template = extractBlock(source, 'template')
  if (!template) {
    problems.push(`${rel}: не найден блок <template>`)
  } else {
    checkTemplateBalance(rel, template.content)
  }

  const script = extractBlock(source, 'script')
  if (script) {
    if (!/lang=["']ts["']/.test(script.attrs)) {
      problems.push(`${rel}: <script> без lang="ts"`)
    }
    const outName = rel.replace(/[\\/]/g, '__').replace(/\.vue$/, '.ts')
    const outPath = join(tmpDir, outName)
    // Компиляторные макросы <script setup> объявляем сами — иначе tsc их не знает.
    const preamble = [
      'declare function defineProps<T>(): Readonly<T>;',
      'declare function defineEmits<T>(): T;',
      'declare function defineExpose(exposed: unknown): void;',
      'export {};',
      '',
    ].join('\n')
    writeFileSync(outPath, preamble + script.content, 'utf8')
    generated.push(outPath)
  } else {
    problems.push(`${rel}: не найден блок <script>`)
  }
}

// Синтаксис: интересуют только ошибки парсера (TS1xxx). Ошибки разрешения
// модулей и типов неизбежны без node_modules и отфильтровываются.
function runTsc(files, label) {
  if (files.length === 0) return
  try {
    execFileSync(
      'tsc',
      [
        '--noEmit',
        '--skipLibCheck',
        '--noResolve',
        '--target', 'es2022',
        '--module', 'esnext',
        '--moduleResolution', 'bundler',
        '--jsx', 'preserve',
        ...files,
      ],
      // cwd вне проекта: иначе tsc отказывается работать при наличии tsconfig.json
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', cwd: tmpDir },
    )
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    if (/TS5\d{3}:/.test(output) || error.code === 'ENOENT') {
      // Конфигурационная ошибка означает, что проверка не выполнялась вовсе —
      // молча «проходить» в этом случае нельзя.
      problems.push(`tsc не запустился (${label}): ${output.trim().split('\n')[0] ?? error.code}`)
      return
    }
    const syntax = output
      .split('\n')
      .filter((line) => /error TS1\d{3}:/.test(line))
    if (syntax.length > 0) {
      problems.push(`Синтаксические ошибки (${label}):`, ...syntax.map((l) => `  ${l}`))
    }
  }
}

runTsc(generated, 'блоки <script setup> из .vue')
runTsc(tsFiles.map((f) => resolve(f)), 'модули .ts')

rmSync(tmpDir, { recursive: true, force: true })

console.log(`Проверено: ${vueFiles.length} .vue, ${tsFiles.length} .ts`)
if (problems.length > 0) {
  console.error('\nНайдены проблемы:')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log('Проблем не найдено.')
