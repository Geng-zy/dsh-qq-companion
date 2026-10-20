/**
 * docs/CONFIG.md is generated from the config schema; this fails when the
 * schema changed and the doc was not regenerated (npm run docs:config).
 * @module dsh-qq-companion/tests/config-doc
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { Config } from '../src/config.js'

describe('docs/CONFIG.md', () => {
  it('matches the config schema', async () => {
    // @ts-expect-error plain .mjs script without type declarations
    const { renderConfigDoc } = await import('../scripts/gen-config-doc.mjs') as { renderConfigDoc(config: unknown): string }
    const doc = readFileSync(join(import.meta.dirname, '..', 'docs', 'CONFIG.md'), 'utf8')
    expect(doc).toBe(renderConfigDoc(Config))
  })
})
