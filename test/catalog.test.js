import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SOURCES,
  sourceKey,
  treeToSkills,
  catalogSummary,
  resolveCommitUrl,
  commitOidOf,
  treeScanUrl,
  prefixTree,
  rawSkillUrl,
  githubSkillUrl,
  createSummaryPrefetcher,
  createGenerationGuard,
  assessCompat,
  assessInstalled,
  resourceRelOk,
  installIdOf,
  normalizeSources,
  listInstalledFiles,
} from '../catalog.js'

// Regression tests for the catalog core. Portable: no absolute paths, no
// install, discovered by `node --test` on a fresh clone.

test('DEFAULT_SOURCES: every entry is scannable (repo shape, label, ref)', () => {
  assert.ok(DEFAULT_SOURCES.length >= 5)
  for (const s of DEFAULT_SOURCES) {
    assert.match(s.repo, /^[\w.-]+\/[\w.-]+$/)
    assert.ok(s.label)
    assert.ok(s.ref)
    assert.equal(typeof s.path, 'string')
  }
})

test('sourceKey: distinguishes two subtrees of the same repo', () => {
  const bundled = { repo: 'NousResearch/hermes-agent', path: 'skills' }
  const optional = { repo: 'NousResearch/hermes-agent', path: 'optional-skills' }
  assert.notEqual(sourceKey(bundled), sourceKey(optional))
})

test('treeToSkills: keeps only SKILL.md dirs, sorted by name', () => {
  const tree = [
    { path: 'skills/pdf/SKILL.md' },
    { path: 'skills/artifacts/SKILL.md' },
    { path: 'skills/pdf/scripts/fill.py' },
    { path: 'README.md' },
    { path: 'skills/notes.md' },
  ]
  assert.deepEqual(treeToSkills(tree, ''), [
    { dir: 'skills/artifacts', name: 'artifacts', id: 'artifacts', installable: true },
    { dir: 'skills/pdf', name: 'pdf', id: 'pdf', installable: true },
  ])
})

test('treeToSkills: a path prefix scopes to that subtree (boundary-safe)', () => {
  const tree = [
    { path: 'skills/a/SKILL.md' },
    { path: 'skills-extra/b/SKILL.md' },
    { path: 'other/c/SKILL.md' },
  ]
  assert.deepEqual(treeToSkills(tree, 'skills'), [
    { dir: 'skills/a', name: 'a', id: 'a', installable: true },
  ])
})

test('treeToSkills: tolerates malformed tree entries and a non-array input', () => {
  assert.deepEqual(treeToSkills(null, ''), [])
  assert.deepEqual(treeToSkills([{}, { path: 42 }, null, { path: 'x/SKILL.md' }], ''), [
    { dir: 'x', name: 'x', id: 'x', installable: true },
  ])
})

test('treeToSkills: a name the installer would reject is non-installable', () => {
  // Spaces, `#`, `?`, `%`, leading punctuation, and non-ASCII all violate the
  // backend `^[a-z0-9][a-z0-9._-]*$` contract — the card must not offer an
  // install that inevitably 400s.
  for (const bad of ['Bad Skill', 'a#frag', 'a?q', 'a%2f', '-lead', 'café']) {
    const [s] = treeToSkills([{ path: `skills/${bad}/SKILL.md` }], 'skills')
    assert.equal(s.id, null, `${bad} → no install id`)
    assert.equal(s.installable, false, `${bad} → not installable`)
  }
  // A clean lowercase name stays installable.
  const [ok] = treeToSkills([{ path: 'skills/pdf/SKILL.md' }], 'skills')
  assert.equal(ok.installable, true)
})

test('treeToSkills: two dirs normalizing to one id are a non-installable collision', () => {
  const skills = treeToSkills(
    [{ path: 'skills/PDF/SKILL.md' }, { path: 'skills/pdf/SKILL.md' }],
    'skills',
  )
  assert.equal(skills.length, 2)
  for (const s of skills) {
    assert.equal(s.id, 'pdf')
    assert.equal(s.installable, false, `${s.dir} collides → not installable`)
    assert.equal(s.collision, true)
  }
})

test('catalogSummary: frontmatter description wins; license and peek extracted', () => {
  const md = [
    '---',
    'name: pdf',
    'description: Work with PDF files.',
    'license: Complete terms in LICENSE.txt',
    '---',
    '# PDF',
    '',
    'Body paragraph here.',
  ].join('\n')
  const s = catalogSummary(md)
  assert.equal(s.description, 'Work with PDF files.')
  assert.equal(s.license, 'Complete terms in LICENSE.txt')
  assert.ok(s.peek.startsWith('# PDF'))
  assert.ok(!s.peek.includes('---\nname'), 'peek is the frontmatter-stripped body')
})

test('catalogSummary: falls back to the first body paragraph, then placeholder copy', () => {
  assert.equal(catalogSummary('# T\n\nFirst paragraph.').description, 'First paragraph.')
  assert.equal(catalogSummary('').description, 'No description in SKILL.md.')
  assert.equal(catalogSummary('').peek, null)
})

test('catalogSummary: peek is capped at 700 chars', () => {
  const s = catalogSummary(`# T\n\n${'x'.repeat(2000)}`)
  assert.equal(s.peek.length, 700)
})

const OID = 'a1b2c3d4'.repeat(5)

test('url builders: scan is scoped to the subtree and everything pins to the OID', () => {
  const src = { repo: 'anthropics/skills', path: 'skills' }
  assert.equal(
    resolveCommitUrl(src),
    'https://api.github.com/repos/anthropics/skills/commits/main',
  )
  assert.equal(
    treeScanUrl(src, OID),
    `https://api.github.com/repos/anthropics/skills/git/trees/${encodeURIComponent(`${OID}:skills`)}?recursive=1`,
  )
  // A whole-repo source scans the OID itself; without an OID the ref shows.
  assert.equal(
    treeScanUrl({ repo: 'o/r' }, OID),
    `https://api.github.com/repos/o/r/git/trees/${OID}?recursive=1`,
  )
  assert.equal(treeScanUrl(src), `https://api.github.com/repos/anthropics/skills/git/trees/${encodeURIComponent('main:skills')}?recursive=1`)
  assert.equal(rawSkillUrl(src, 'skills/pdf', OID), `https://raw.githubusercontent.com/anthropics/skills/${OID}/skills/pdf/SKILL.md`)
  assert.equal(githubSkillUrl(src, 'skills/pdf', OID), `https://github.com/anthropics/skills/blob/${OID}/skills/pdf/SKILL.md`)
  assert.equal(githubSkillUrl({ ...src, ref: 'v2' }, 'skills/pdf'), 'https://github.com/anthropics/skills/blob/v2/skills/pdf/SKILL.md')
})

test('url builders percent-encode each path segment (preview == install target)', () => {
  const src = { repo: 'o/r', path: 'skills' }
  // `#`, `?`, `%`, space, and non-ASCII must be encoded per segment (the `/`
  // separators survive) so the previewed/assessed URL is the one the backend —
  // which quotes the same path — actually fetches.
  assert.equal(
    rawSkillUrl(src, 'skills/a#frag', OID),
    `https://raw.githubusercontent.com/o/r/${OID}/skills/a%23frag/SKILL.md`,
  )
  assert.equal(
    rawSkillUrl(src, 'skills/a?d=1', OID),
    `https://raw.githubusercontent.com/o/r/${OID}/skills/a%3Fd%3D1/SKILL.md`,
  )
  assert.equal(
    githubSkillUrl(src, 'skills/a b', OID),
    `https://github.com/o/r/blob/${OID}/skills/a%20b/SKILL.md`,
  )
  assert.equal(
    rawSkillUrl(src, 'skills/café', OID),
    `https://raw.githubusercontent.com/o/r/${OID}/skills/caf%C3%A9/SKILL.md`,
  )
})

test('commitOidOf accepts only a 40-hex sha', () => {
  assert.equal(commitOidOf({ sha: OID }), OID)
  assert.equal(commitOidOf({ sha: 'main' }), null)
  assert.equal(commitOidOf({ sha: OID.slice(1) }), null)
  assert.equal(commitOidOf({}), null)
  assert.equal(commitOidOf(null), null)
})

test('prefixTree re-prefixes scoped tree paths to repo-relative', () => {
  const scoped = [
    { type: 'blob', path: 'pdf/SKILL.md', size: 4 },
    { type: 'tree', path: 'pdf' },
  ]
  assert.deepEqual(
    prefixTree(scoped, 'skills/').map((e) => e.path),
    ['skills/pdf/SKILL.md', 'skills/pdf'],
  )
  // Whole-repo sources pass through untouched.
  assert.equal(prefixTree(scoped, '')[0].path, 'pdf/SKILL.md')
  assert.deepEqual(prefixTree(null, 'x'), [])
})

test('prefetcher: bounds concurrency and still visits every dir', async () => {
  let inflight = 0
  let peak = 0
  const seen = []
  const prefetcher = createSummaryPrefetcher({
    concurrency: 2,
    loadOne: async (dir) => {
      inflight += 1
      peak = Math.max(peak, inflight)
      seen.push(dir)
      await new Promise((resolve) => setImmediate(resolve))
      inflight -= 1
    },
  })
  prefetcher.start(['a', 'b', 'c', 'd', 'e'])
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual([...seen].sort(), ['a', 'b', 'c', 'd', 'e'])
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded the bound`)
})

test('prefetcher: a rejecting loadOne does not stall the pool', async () => {
  const seen = []
  const prefetcher = createSummaryPrefetcher({
    concurrency: 1,
    loadOne: async (dir) => {
      seen.push(dir)
      if (dir === 'bad') throw new Error('boom')
    },
  })
  prefetcher.start(['bad', 'good'])
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(seen, ['bad', 'good'])
})

test('prefetcher: starting a new pool strands the previous generation', async () => {
  const seen = []
  let releaseFirst
  const gate = new Promise((resolve) => { releaseFirst = resolve })
  const prefetcher = createSummaryPrefetcher({
    concurrency: 1,
    loadOne: async (dir) => {
      seen.push(dir)
      if (dir === 'old-1') await gate // old pool blocks until after the switch
    },
  })
  prefetcher.start(['old-1', 'old-2'])
  await new Promise((resolve) => setImmediate(resolve))
  prefetcher.start(['new-1'])
  releaseFirst()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(seen.includes('new-1'))
  assert.ok(!seen.includes('old-2'), 'the superseded pool must not continue its queue')
})

test('prefetcher: cancel() stops the pool without starting another', async () => {
  const seen = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const prefetcher = createSummaryPrefetcher({
    concurrency: 1,
    loadOne: async (dir) => {
      seen.push(dir)
      if (dir === 'a') await gate
    },
  })
  prefetcher.start(['a', 'b'])
  await new Promise((resolve) => setImmediate(resolve))
  prefetcher.cancel()
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(seen, ['a'])
})

// --- resourceRelOk: EXACT mirror of the backend's _resource_rel_ok ---

test('resourceRelOk matches the backend contract case for case', () => {
  assert.ok(resourceRelOk('ref.md'))
  assert.ok(resourceRelOk('scripts/run.py'))
  assert.ok(resourceRelOk('a/b/c/deep.md')) // 4 segments = at the cap
  assert.ok(!resourceRelOk('a/b/c/d/deep.md')) // 5 segments — backend drops it
  assert.ok(!resourceRelOk('../up.md'))
  assert.ok(!resourceRelOk('.hidden.md'))
  assert.ok(!resourceRelOk('dir/.hidden.md'))
  assert.ok(!resourceRelOk('dir//double.md'))
  assert.ok(!resourceRelOk('win\\path.md'))
  assert.ok(!resourceRelOk('binary.png'))
  assert.ok(!resourceRelOk(''))
})

test('assessCompat: depth-5 and dot-prefixed files are dropped exactly like the installer', () => {
  const tree = [
    blob(`${DIR}/SKILL.md`),
    blob(`${DIR}/a/b/c/at-cap.md`), // 4 segments — installs
    blob(`${DIR}/a/b/c/d/over.md`), // 5 segments — the backend drops this
    blob(`${DIR}/.github/ci.yml`),
  ]
  const res = assessCompat(tree, DIR, OK_MD)
  const dropped = res.caveats.find((c) => c.kind === 'dropped')
  assert.ok(dropped)
  assert.match(dropped.text, /over\.md/)
  assert.match(dropped.text, /ci\.yml/)
  assert.ok(!dropped.text.includes('at-cap.md'))
})

// --- install identity + source-override validation ---

test('installIdOf lowercases like the server derivation; treeToSkills carries it', () => {
  assert.equal(installIdOf('PDF'), 'pdf')
  const tree = [{ type: 'blob', path: 'skills/PDF/SKILL.md' }]
  const [skill] = treeToSkills(tree, 'skills')
  assert.equal(skill.name, 'PDF')
  assert.equal(skill.id, 'pdf') // installed checks compare THIS
})

test('installIdOf returns null for names the backend name contract rejects', () => {
  for (const bad of ['Bad Skill', 'a#frag', 'a?q', 'a%2f', '-lead', '.dot', 'café', '']) {
    assert.equal(installIdOf(bad), null, bad)
  }
  assert.equal(installIdOf('pdf-forms.v2'), 'pdf-forms.v2')
})

test('normalizeSources drops malformed entries, caps the list, keeps defaults-compatible shapes', () => {
  const good = { label: 'Ok', repo: 'o/r', path: 'skills', ref: 'main' }
  const out = normalizeSources([
    good,
    'not-an-object',
    { repo: 'no-slash' },
    { repo: 'o/r', path: '../up' },
    { repo: 'o/r', path: 'ok', ref: 'bad ref!' },
    { repo: 'o/r2', label: '  padded   label  ' },
  ])
  assert.deepEqual(out[0], good)
  assert.equal(out.length, 2)
  assert.equal(out[1].label, 'padded label')
  assert.equal(out[1].ref, 'main')
  assert.equal(normalizeSources('garbage').length, 0)
  assert.equal(normalizeSources([{ repo: `o/r`, path: 'x'.repeat(300) }]).length, 0)
  const oversized = Array.from({ length: 30 }, (_, i) => ({ repo: `o/r${i}` }))
  assert.equal(normalizeSources(oversized).length, 12)
  // Every default source survives its own validation.
  assert.equal(normalizeSources(DEFAULT_SOURCES).length, DEFAULT_SOURCES.length)
})

test('normalizeSources rejects a control character in the path (URL-builder safety)', () => {
  assert.equal(normalizeSources([{ repo: 'o/r', path: 'a\u0000b' }]).length, 0)
  assert.equal(normalizeSources([{ repo: 'o/r', path: 'a\u001fb' }]).length, 0)
  // A legitimate hyphenated path is untouched.
  assert.equal(normalizeSources([{ repo: 'o/r', path: 'sub-dir/skills' }]).length, 1)
})

// --- listInstalledFiles: encoded, complete-or-no-verdict traversal ---

function cannedLister(pages) {
  const seen = []
  const fetchJson = async (url) => {
    seen.push(url)
    return url in pages ? pages[url] : null
  }
  return { fetchJson, seen }
}

test('listInstalledFiles walks nested dirs with segment-encoded URLs', async () => {
  const base = '/api/storage/shared-list/skills'
  const { fetchJson, seen } = cannedLister({
    [`${base}/my.skill?limit=200`]: { entries: [
      { name: 'SKILL.md', type: 'file' },
      { name: 'my docs', type: 'directory' },
    ], next_cursor: null },
    [`${base}/my.skill/my%20docs?limit=200`]: { entries: [
      { name: '100%.py', type: 'file' },
    ], next_cursor: null },
  })
  const files = await listInstalledFiles(fetchJson, 'my.skill')
  // The dir with a space was requested ENCODED (the canned map only answers
  // the encoded URL), and rel paths stay raw for the compat check.
  assert.deepEqual(files.sort(), ['SKILL.md', 'my docs/100%.py'])
  assert.equal(seen[1], `${base}/my.skill/my%20docs?limit=200`)
})

test('listInstalledFiles returns null (no verdict) on any incomplete walk', async () => {
  const base = '/api/storage/shared-list/skills'
  // A paginated directory — more entries exist than we walked.
  let { fetchJson } = cannedLister({
    [`${base}/s?limit=200`]: { entries: [{ name: 'SKILL.md', type: 'file' }], next_cursor: 'more' },
  })
  assert.equal(await listInstalledFiles(fetchJson, 's'), null)
  // A failed page.
  ;({ fetchJson } = cannedLister({}))
  assert.equal(await listInstalledFiles(fetchJson, 's'), null)
  // A directory too deep to enumerate is unknown, not implicitly empty.
  ;({ fetchJson } = cannedLister({
    [`${base}/s?limit=200`]: { entries: [{ name: 'a', type: 'directory' }], next_cursor: null },
    [`${base}/s/a?limit=200`]: { entries: [{ name: 'b', type: 'directory' }], next_cursor: null },
    [`${base}/s/a/b?limit=200`]: { entries: [{ name: 'c', type: 'directory' }], next_cursor: null },
    [`${base}/s/a/b/c?limit=200`]: { entries: [{ name: 'd', type: 'directory' }], next_cursor: null },
  }))
  assert.equal(await listInstalledFiles(fetchJson, 's'), null)
  // Page budget exhausted with work remaining.
  const many = { entries: Array.from({ length: 30 }, (_, i) => ({ name: `d${i}`, type: 'directory' })), next_cursor: null }
  const pages = { [`${base}/s?limit=200`]: many }
  for (let i = 0; i < 30; i++) pages[`${base}/s/d${i}?limit=200`] = { entries: [], next_cursor: null }
  ;({ fetchJson } = cannedLister(pages))
  assert.equal(await listInstalledFiles(fetchJson, 's'), null)
})

// --- generation guard: stale catalog responses must be dropped ---

test('generationGuard: tokens go stale on next() and cancel()', () => {
  const guard = createGenerationGuard()
  const a = guard.next()
  assert.equal(guard.isCurrent(a), true)
  const b = guard.next()
  assert.equal(guard.isCurrent(a), false)
  assert.equal(guard.isCurrent(b), true)
  guard.cancel()
  assert.equal(guard.isCurrent(b), false)
})

// Models CatalogScreen.openSource exactly: each scan takes a token, awaits
// its tree fetch, and only commits state while its token is current. A opens
// first but responds LAST — its late tree must not overwrite B's.
test('generationGuard: slow tree response for A cannot overwrite current B', async () => {
  const guard = createGenerationGuard()
  const state = {}
  const gate = {}
  const trees = {
    A: new Promise((res) => { gate.A = () => res(['a-skill']) }),
    B: new Promise((res) => { gate.B = () => res(['b-skill']) }),
  }
  const openSource = async (name) => {
    const token = guard.next()
    const tree = await trees[name]
    if (!guard.isCurrent(token)) return
    state.open = name
    state.skills = tree
  }
  const a = openSource('A')
  const b = openSource('B')
  gate.B(); await b // B (current) resolves first and commits
  gate.A(); await a // A resolves after — stale token, dropped
  assert.equal(state.open, 'B')
  assert.deepEqual(state.skills, ['b-skill'])
})

// Models loadDescription: markdown for a dir name that exists in BOTH sources
// arrives after the source switched — the stale bytes must not populate the
// new source's cache for that same dir key.
test('generationGuard: stale markdown for a shared dir name is dropped', async () => {
  const guard = createGenerationGuard()
  let descs = {}
  const gate = {}
  const md = {
    A: new Promise((res) => { gate.A = () => res('# from A') }),
    B: new Promise((res) => { gate.B = () => res('# from B') }),
  }
  const loadDescription = async (sourceName, dir, token) => {
    const text = await md[sourceName]
    if (!guard.isCurrent(token)) return
    descs = { ...descs, [dir]: text }
  }
  const tokenA = guard.next()
  const inflightA = loadDescription('A', 'skills/pdf', tokenA)
  const tokenB = guard.next() // source switched; caches were reset
  descs = {}
  const inflightB = loadDescription('B', 'skills/pdf', tokenB)
  gate.B(); await inflightB
  gate.A(); await inflightA // A's bytes arrive last, for the SAME dir key
  assert.equal(descs['skills/pdf'], '# from B')
})

// --- assessCompat: the pre-install badge's prediction of the installer ---

const blob = (path, size = 100) => ({ path, type: 'blob', size })
const DIR = 'skills/pdf'
const OK_MD = '---\nname: pdf\ndescription: Fill and read PDFs.\n---\n\nProse body.\n'

test('assessCompat: clean prose skill is ok', () => {
  const tree = [blob(`${DIR}/SKILL.md`), blob(`${DIR}/references/forms.md`)]
  const res = assessCompat(tree, DIR, OK_MD)
  assert.equal(res.ok, true)
  assert.deepEqual(res.caveats, [])
})

test('assessCompat: a SKILL.md over the 256 KiB fetch cap is flagged (not false-green)', () => {
  // Boundary: exactly at the cap is fine; one byte over is a caveat.
  const cap = 256 * 1024
  const atCap = assessCompat([blob(`${DIR}/SKILL.md`, cap)], DIR, OK_MD)
  assert.equal(atCap.ok, true)
  const over = assessCompat([blob(`${DIR}/SKILL.md`, cap + 1)], DIR, OK_MD)
  const c = over.caveats.find((x) => x.kind === 'skill-too-large')
  assert.ok(c, 'expected a skill-too-large caveat')
  assert.equal(over.caveats[0].kind, 'skill-too-large') // most serious first
})

test('assessCompat: disallowed extensions and deep nesting are flagged as dropped', () => {
  const tree = [
    blob(`${DIR}/SKILL.md`),
    blob(`${DIR}/binary.wasm`),
    blob(`${DIR}/a/b/c/d/e/deep.md`),
  ]
  const res = assessCompat(tree, DIR, OK_MD)
  const dropped = res.caveats.find((c) => c.kind === 'dropped')
  assert.ok(dropped)
  assert.match(dropped.text, /2 extra files/)
  assert.match(dropped.text, /binary\.wasm/)
})

test('assessCompat: over the file-count budget → installs partially', () => {
  const tree = [blob(`${DIR}/SKILL.md`)]
  for (let i = 0; i < 30; i++) tree.push(blob(`${DIR}/ref-${i}.md`))
  const res = assessCompat(tree, DIR, OK_MD)
  const over = res.caveats.find((c) => c.kind === 'over-budget')
  assert.ok(over)
  assert.match(over.text, /30 files \(max 24\)/)
})

test('assessCompat: over the total-size budget → installs partially', () => {
  const tree = [blob(`${DIR}/SKILL.md`), blob(`${DIR}/big.csv`, 3 * 1024 * 1024)]
  const res = assessCompat(tree, DIR, OK_MD)
  const over = res.caveats.find((c) => c.kind === 'over-budget')
  assert.ok(over)
  assert.match(over.text, /max 2 MB/)
})

test('assessCompat: bundled scripts are an informational caveat', () => {
  const tree = [blob(`${DIR}/SKILL.md`), blob(`${DIR}/scripts/fill.py`)]
  const res = assessCompat(tree, DIR, OK_MD)
  assert.equal(res.ok, false)
  const scripts = res.caveats.find((c) => c.kind === 'scripts')
  assert.match(scripts.text, /nothing runs automatically/)
})

test('assessCompat: missing frontmatter description is flagged', () => {
  const tree = [blob(`${DIR}/SKILL.md`)]
  const res = assessCompat(tree, DIR, '# PDF skill\n\nJust a body.\n')
  const fm = res.caveats.find((c) => c.kind === 'frontmatter')
  assert.ok(fm)
})

test('assessCompat: multi-line YAML description defeats the flat parser → flagged', () => {
  const raw = '---\nname: pdf\ndescription: >\n  Long folded\n  description.\n---\n\nBody.\n'
  const res = assessCompat([blob(`${DIR}/SKILL.md`)], DIR, raw)
  assert.ok(res.caveats.find((c) => c.kind === 'frontmatter'))
})

test('assessCompat: refs to dropped or absent files are the broken-refs caveat', () => {
  const tree = [blob(`${DIR}/SKILL.md`), blob(`${DIR}/helper.rb`)]
  const raw = `${OK_MD}\nRun [the helper](helper.rb), read \`scripts/gone.py\`, see [docs](https://example.com/x.md).\n`
  const res = assessCompat(tree, DIR, raw)
  const broken = res.caveats.find((c) => c.kind === 'broken-refs')
  assert.ok(broken)
  assert.match(broken.text, /helper\.rb/)
  assert.match(broken.text, /scripts\/gone\.py/)
  assert.ok(!broken.text.includes('example.com'))
})

test('assessCompat: bare inline-code filenames and dir refs are not treated as refs', () => {
  const tree = [blob(`${DIR}/SKILL.md`)]
  const raw = `${OK_MD}\nMention \`package.json\` and [the scripts](scripts/) generically.\n`
  const res = assessCompat(tree, DIR, raw)
  assert.equal(res.caveats.find((c) => c.kind === 'broken-refs'), undefined)
})

test('assessCompat: shell snippets and home/abs paths in inline code are not refs', () => {
  const tree = [blob(`${DIR}/SKILL.md`)]
  const raw = `${OK_MD}\nRun \`open /tmp/review_<name>.html\`, save to \`~/Downloads/set.json\`, read \`/etc/hosts.conf\`.\n`
  const res = assessCompat(tree, DIR, raw)
  assert.equal(res.caveats.find((c) => c.kind === 'broken-refs'), undefined)
})

// --- assessInstalled: the same verdict for skills already on disk ---

test('assessInstalled: clean installed skill with its files present is ok', () => {
  const raw = `${OK_MD}\nSee [the forms guide](references/forms.md).\n`
  const res = assessInstalled(['references/forms.md'], raw)
  assert.equal(res.ok, true)
  assert.deepEqual(res.caveats, [])
})

test('assessInstalled: refs to files not on disk are broken-refs', () => {
  const raw = `${OK_MD}\nRun \`scripts/fill.py\` first.\n`
  const res = assessInstalled([], raw)
  const broken = res.caveats.find((c) => c.kind === 'broken-refs')
  assert.ok(broken)
  assert.match(broken.text, /scripts\/fill\.py/)
})

test('assessInstalled: installed scripts are the informational caveat', () => {
  const res = assessInstalled(['scripts/fill.py'], `${OK_MD}\nRun \`scripts/fill.py\`.\n`)
  assert.equal(res.ok, false)
  const scripts = res.caveats.find((c) => c.kind === 'scripts')
  assert.match(scripts.text, /nothing runs automatically/)
  assert.equal(res.caveats.find((c) => c.kind === 'broken-refs'), undefined)
})

test('assessInstalled: flat skill (no files) with plain prose and a description is ok', () => {
  assert.equal(assessInstalled([], OK_MD).ok, true)
})

test('assessInstalled: missing frontmatter description is flagged', () => {
  const res = assessInstalled([], '# Notes\n\nJust a body.\n')
  assert.ok(res.caveats.find((c) => c.kind === 'frontmatter'))
})

test('assessInstalled: SKILL.md itself never counts as a resource or a broken ref', () => {
  const res = assessInstalled(['SKILL.md'], `${OK_MD}\nSee [itself](SKILL.md).\n`)
  assert.equal(res.ok, true)
})

test('assessCompat: files outside the skill dir are ignored', () => {
  const tree = [
    blob(`${DIR}/SKILL.md`),
    blob('skills/other/huge.bin', 10 * 1024 * 1024),
    blob('README.rb'),
  ]
  const res = assessCompat(tree, DIR, OK_MD)
  assert.equal(res.ok, true)
})
