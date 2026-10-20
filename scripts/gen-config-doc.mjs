#!/usr/bin/env node
// Generate docs/CONFIG.md from the plugin's config schema (names, types,
// defaults and descriptions), so the reference never drifts from the code.
// Usage: npm run docs:config   (tests/config-doc.spec.ts fails when stale)
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const typeOf = schema => {
  if (schema.type === 'union') return schema.list.map(item => JSON.stringify(item.value ?? item.type)).join(' / ')
  if (schema.type === 'array') return typeOf(schema.inner ?? { type: 'any' }) + '[]'
  if (schema.type === 'const') return JSON.stringify(schema.value)
  return schema.type
}

const cell = text => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ')

const showDefault = value => {
  if (value === undefined) return ''
  const text = JSON.stringify(value)
  return text.length > 40 ? '（见说明）' : '`' + text + '`'
}

/** Render the reference page from the Config schema. */
export function renderConfigDoc(Config) {
  const rows = Object.entries(Config.dict).map(([key, schema]) =>
    '| `' + key + '` | ' + cell(typeOf(schema)) + ' | ' + showDefault(schema.meta?.default) + ' | ' + cell(schema.meta?.description ?? '') + ' |')
  return [
    '# 配置项',
    '',
    '> 由 `npm run docs:config` 从 `src/config.ts` 生成，不要手改。',
    '> 配置写在 dsh profile 的 `cordis.patch.yml` 里 `id: dsh-onebot` 那一行的 `config:` 下，也可以在 dsh 网页的设置里改其中常用的几十项。',
    '',
    '| 键 | 类型 | 默认值 | 说明 |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const { Config } = await import(join(root, 'lib', 'config.js'))
  writeFileSync(join(root, 'docs', 'CONFIG.md'), renderConfigDoc(Config))
  console.log('docs/CONFIG.md: ' + Object.keys(Config.dict).length + ' 项')
}
