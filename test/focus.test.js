import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')

test('opening Skills puts its unified search under the keyboard', () => {
  assert.match(
    source,
    /className="sk-input" type="search" autoFocus value=\{query\}/,
    'the installed-and-registry search should receive focus when it mounts',
  )
})
