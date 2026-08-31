import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')

test('header divider stays inside the 760px reading rail', () => {
  const inner = source.match(/\.sk-header-inner\s*\{([^}]*)\}/s)?.[1]

  assert.doesNotMatch(source, /\.sk-header\s*\{[^}]*border-bottom/s)
  assert.ok(inner, 'the centered header rail should remain defined')
  assert.match(inner, /max-width:\s*760px/)
  assert.match(inner, /border-bottom:\s*1px solid var\(--border\)/)
})
