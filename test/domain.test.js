import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSkill, classifyLink, friendlyLoadError } from '../domain.js'

// Regression tests for the pure core. Portable: no absolute paths, no install,
// discovered by `node --test` on a fresh clone.

test('parseSkill: title from first heading, description from first paragraph', () => {
  const s = parseSkill('building-apps.md', '# Building mini-apps\n\nThe full mini-app contract.\n\nMore text here.')
  assert.equal(s.slug, 'building-apps')
  assert.equal(s.name, 'building-apps.md')
  assert.equal(s.title, 'Building mini-apps')
  assert.equal(s.description, 'The full mini-app contract.')
  assert.equal(s.content, '# Building mini-apps\n\nThe full mini-app contract.\n\nMore text here.')
})

test('parseSkill: falls back to Title-Cased slug when no heading', () => {
  const s = parseSkill('cron-jobs.md', 'no heading here, just prose')
  assert.equal(s.title, 'Cron Jobs')
})

test('parseSkill: a "# comment" inside a fenced code block is not the title', () => {
  const md = '```bash\n# not a title\necho hi\n```\n\n# Real Title\n\nReal description.'
  const s = parseSkill('x.md', md)
  assert.equal(s.title, 'Real Title')
  assert.equal(s.description, 'Real description.')
})

test('parseSkill: description skips a fenced block and stops at the next heading', () => {
  const md = '# T\n\nFirst para.\n\n## Section\n\nSecond para.'
  const s = parseSkill('x.md', md)
  assert.equal(s.description, 'First para.')
})

test('parseSkill: empty content still yields a slug-derived title and empty description', () => {
  const s = parseSkill('theming.md', '')
  assert.equal(s.title, 'Theming')
  assert.equal(s.description, '')
})

test('classifyLink: same-folder .md link resolves to a skill slug', () => {
  assert.deepEqual(classifyLink('app-component-shapes.md'), { kind: 'skill', slug: 'app-component-shapes' })
})

test('classifyLink: ./-prefixed and query/hash-suffixed .md still resolve', () => {
  assert.deepEqual(classifyLink('./notifications.md'), { kind: 'skill', slug: 'notifications' })
  assert.deepEqual(classifyLink('cron.md#schedule'), { kind: 'skill', slug: 'cron' })
})

test('classifyLink: http/https open externally', () => {
  assert.deepEqual(classifyLink('https://example.com/x'), { kind: 'external', url: 'https://example.com/x' })
  assert.deepEqual(classifyLink('http://example.com'), { kind: 'external', url: 'http://example.com' })
})

test('classifyLink: unsupported protocols are blocked', () => {
  assert.equal(classifyLink('mailto:a@b.com').kind, 'blocked')
  assert.equal(classifyLink('javascript:alert(1)').kind, 'blocked')
  assert.equal(classifyLink('file:///etc/passwd').kind, 'blocked')
})

test('classifyLink: sub-path relative links are blocked (no in-app target)', () => {
  assert.equal(classifyLink('sub/dir/other.md').kind, 'blocked')
  assert.equal(classifyLink('../up.md').kind, 'blocked')
})

test('classifyLink: in-page fragments are anchors (harmless)', () => {
  assert.deepEqual(classifyLink('#section'), { kind: 'anchor' })
})

test('classifyLink: empty/missing href is blocked, never navigated', () => {
  assert.equal(classifyLink('').kind, 'blocked')
  assert.equal(classifyLink(null).kind, 'blocked')
  assert.equal(classifyLink(undefined).kind, 'blocked')
})

test('friendlyLoadError: network failures become actionable copy', () => {
  assert.match(friendlyLoadError(new Error('Failed to fetch')), /connection/i)
  assert.match(friendlyLoadError(new Error('list 500')), /error/i)
})
