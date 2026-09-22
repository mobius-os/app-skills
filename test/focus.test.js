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

test('reviewing an update moves focus into the visible catalog and hides the list surface', () => {
  assert.match(source, /const backRef = useRef\(null\)/)
  assert.match(source, /if \(visible\) backRef\.current\?\.focus\(\)/)
  assert.match(source, /ref=\{backRef\} className="sk-back"/)
  assert.match(source, /className="sk-header"[^>]*aria-hidden=\{catalogOpen \? 'true' : undefined\}[^>]*inert=\{catalogOpen\}/)
  assert.match(source, /className="sk-scroll" ref=\{mainScrollRef\}[^>]*aria-hidden=\{catalogOpen \? 'true' : undefined\}[^>]*inert=\{catalogOpen\}/)
})

test('review and update actions retain the app touch-target floor', () => {
  assert.match(source, /\.sk-btn \{ min-height: 44px;/)
})
