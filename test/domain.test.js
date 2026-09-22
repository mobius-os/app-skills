import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSkill,
  classifyLink,
  mapSkillRows,
  mergeConfirmedSkill,
  createSkillsLoader,
  loadLegacySkills,
  selectSystemPromptApps,
  fetchSystemPromptApps,
  createSystemPromptAppsLoader,
  installedAppDisplayName,
  friendlyLoadError,
  skillContentPath,
  provenanceChip,
  isUninstallable,
  catalogUpdateTarget,
  catalogEntryForInstalled,
  catalogUpdateAvailability,
  catalogUpdatePayload,
  catalogInstallPayload,
  skillDisplayTitle,
  usageLabel,
} from '../domain.js'

// Regression tests for the dependency-free core. Portable: no absolute paths,
// no install, discovered by `node --test` on a fresh clone.

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

test('parseSkill: strips frontmatter from rendered content', () => {
  const md = [
    '---',
    'name: impeccable',
    'description: Improve frontend interfaces.',
    'version: 4.3.1',
    '---',
    '# impeccable',
    '',
    'Use this skill for product UI polish.',
  ].join('\n')
  const s = parseSkill('impeccable.md', md)
  assert.equal(s.title, 'impeccable')
  assert.equal(s.description, 'Use this skill for product UI polish.')
  assert.equal(s.version, '4.3.1')
  assert.equal(s.content, '# impeccable\n\nUse this skill for product UI polish.')
})

test('parseSkill: uses frontmatter description as fallback only when body has none', () => {
  const s = parseSkill('quiet-mode.md', '---\nname: quiet-mode\ndescription: Calm the interface.\n---\n# Quiet Mode')
  assert.equal(s.title, 'Quiet Mode')
  assert.equal(s.description, 'Calm the interface.')
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

test('selectSystemPromptApps: keeps only true system apps with a prompt file and sorts by name', () => {
  const apps = [
    { id: 4, name: 'Memory', system_app: true, system_prompt_file: 'memory-core.md' },
    { id: 2, name: 'Artifacts', system_app: true, system_prompt_file: 'artifacts-core.md' },
    { id: 1, name: 'Skills', system_app: false, system_prompt_file: 'skills-core.md' },
    { id: 3, name: 'Legacy', system_app: true, system_prompt_file: null },
    { id: 6, name: 'Blank', system_app: true, system_prompt_file: '' },
    { id: 5, name: 'Truthy only', system_app: 1, system_prompt_file: 'truthy-core.md' },
  ]

  assert.deepEqual(selectSystemPromptApps(apps).map((app) => app.name), ['Artifacts', 'Memory'])
})

test('selectSystemPromptApps: malformed API payloads are safely empty', () => {
  assert.deepEqual(selectSystemPromptApps(null), [])
  assert.deepEqual(selectSystemPromptApps({ apps: [] }), [])
})

test('fetchSystemPromptApps: HTTP, fetch, and malformed JSON failures degrade to an empty section', async () => {
  const cases = [
    async () => ({ ok: false, status: 500 }),
    async () => { throw new Error('network down') },
    async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON') } }),
    async () => ({ ok: true, json: async () => ({ apps: [] }) }),
  ]

  for (const fetchImpl of cases) {
    assert.deepEqual(await fetchSystemPromptApps(fetchImpl, { Authorization: 'Bearer test' }), [])
  }
})

test('fetchSystemPromptApps: an empty apps response omits the supplemental section', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [] })
  assert.deepEqual(await fetchSystemPromptApps(fetchImpl, {}), [])
})

test('system prompt apps loader: a slow apps response cannot block the primary skills flow', async () => {
  let resolveApps
  const pendingApps = new Promise((resolve) => { resolveApps = resolve })
  const committed = []
  const loader = createSystemPromptAppsLoader({
    fetchImpl: async () => ({ ok: true, json: () => pendingApps }),
    onApps: (apps) => committed.push(apps),
  })

  const startResult = loader.load({})
  const skills = await Promise.resolve(['Rendered skill'])
  assert.equal(startResult, undefined, 'supplemental load is intentionally fire-and-forget')
  assert.deepEqual(skills, ['Rendered skill'])
  assert.deepEqual(committed, [], 'the apps request is still pending')

  resolveApps([])
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(committed, [[]])
})

test('system prompt apps loader: only the latest overlapping request may commit', async () => {
  let resolveOlder
  let resolveNewer
  const older = new Promise((resolve) => { resolveOlder = resolve })
  const newer = new Promise((resolve) => { resolveNewer = resolve })
  let request = 0
  const committed = []
  const loader = createSystemPromptAppsLoader({
    fetchImpl: async () => ({ ok: true, json: () => (request++ === 0 ? older : newer) }),
    onApps: (apps) => committed.push(apps.map((app) => app.name)),
  })

  loader.load({})
  loader.load({})
  resolveNewer([{ id: 2, name: 'Newer', system_app: true, system_prompt_file: 'newer.md' }])
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(committed, [['Newer']])

  resolveOlder([{ id: 1, name: 'Older', system_app: true, system_prompt_file: 'older.md' }])
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(committed, [['Newer']], 'the stale response cannot overwrite the latest state')
})

test('installedAppDisplayName: trims name, then falls back to slug and neutral copy', () => {
  assert.equal(installedAppDisplayName({ name: '  Memory  ', slug: 'memory' }), 'Memory')
  assert.equal(installedAppDisplayName({ name: '   ', slug: '  legacy-app  ' }), 'legacy-app')
  assert.equal(installedAppDisplayName({ name: '', slug: '' }), 'Installed app')
  assert.equal(installedAppDisplayName(null), 'Installed app')
})

test('skillContentPath: flat skills read <id>.md, directory skills read <id>/SKILL.md', () => {
  assert.equal(skillContentPath({ id: 'cron', is_dir: false }), '/api/storage/shared/skills/cron.md')
  assert.equal(skillContentPath({ id: 'skill-creator', is_dir: true }), '/api/storage/shared/skills/skill-creator/SKILL.md')
})

test('skillContentPath: the id is URL-encoded, never path-spliced raw', () => {
  assert.equal(skillContentPath({ id: 'a b', is_dir: false }), '/api/storage/shared/skills/a%20b.md')
  assert.equal(skillContentPath({ id: 'x/y', is_dir: true }), '/api/storage/shared/skills/x%2Fy/SKILL.md')
})

test('provenanceChip: each provenance family maps to a stable kind + readable label', () => {
  assert.deepEqual(provenanceChip('seed').kind, 'seed')
  assert.equal(provenanceChip('seed').label, 'built-in')
  assert.equal(provenanceChip('agent').kind, 'agent')
  assert.deepEqual(provenanceChip('app:memory'), { kind: 'app', label: 'app · memory', title: 'Owned by the memory app' })
  const inst = provenanceChip('installed:anthropics/skills')
  assert.equal(inst.kind, 'installed')
  assert.equal(inst.label, 'anthropics/skills')
})

test('provenanceChip: unknown or missing provenance degrades to a neutral chip', () => {
  assert.equal(provenanceChip('').kind, 'other')
  assert.equal(provenanceChip(undefined).kind, 'other')
  assert.equal(provenanceChip('installed:').label, 'installed')
})

test('isUninstallable: only installed:* provenance may be removed in-app', () => {
  assert.equal(isUninstallable('installed:anthropics/skills'), true)
  assert.equal(isUninstallable('seed'), false)
  assert.equal(isUninstallable('agent'), false)
  assert.equal(isUninstallable('app:memory'), false)
  assert.equal(isUninstallable(undefined), false)
})

test('catalogUpdateTarget: managed skills match repo and path before id', () => {
  const custom = {
    id: 'my-pdf-tools', provenance: 'installed:o/r', sourceRepo: 'o/r',
    sourcePath: '/skills/pdf/', sourceRef: 'stable', treeDigest: 'sha256-tree-v1:custom',
  }
  const colliding = {
    id: 'pdf', provenance: 'installed:elsewhere/r', sourceRepo: 'elsewhere/r',
    sourcePath: 'skills/pdf', sourceRef: 'stable', treeDigest: 'sha256-tree-v1:collision',
  }
  const rows = new Map([[custom.id, custom], [colliding.id, colliding]])
  assert.equal(catalogUpdateTarget(rows, { repo: 'o/r', ref: 'stable' }, 'skills/pdf', 'pdf'), custom)
  assert.equal(catalogUpdateTarget(rows, { repo: 'o/r', ref: 'main' }, 'skills/pdf', 'pdf'), custom)
})

test('catalogUpdateTarget: basename fallback is only for explicit agent adoption', () => {
  const agent = { id: 'pdf', provenance: 'agent', treeDigest: 'sha256-tree-v1:agent' }
  assert.equal(catalogUpdateTarget([agent], { repo: 'o/r' }, 'skills/pdf', 'pdf'), agent)
  const otherManaged = {
    id: 'pdf', provenance: 'installed:other/r', sourceRepo: 'other/r',
    sourcePath: 'skills/pdf', sourceRef: 'main', treeDigest: 'sha256-tree-v1:other',
  }
  assert.equal(catalogUpdateTarget([otherManaged], { repo: 'o/r' }, 'skills/pdf', 'pdf'), null)
})

test('catalogEntryForInstalled: custom managed names use full source coordinates', () => {
  const exact = { id: 'pdf', repo: 'o/r', path: 'skills/pdf', ref: 'stable' }
  const idCollision = { id: 'my-pdf', repo: 'other/r', path: 'skills/my-pdf', ref: 'main' }
  const installed = {
    id: 'my-pdf', provenance: 'installed:o/r', sourceRepo: 'o/r',
    sourcePath: '/skills/pdf/', sourceRef: 'stable',
  }
  assert.equal(catalogEntryForInstalled([idCollision, exact], installed), exact)
  assert.equal(catalogEntryForInstalled([{ ...exact, ref: 'main' }], installed), null)
  assert.equal(catalogEntryForInstalled([idCollision], installed), null)
})

test('catalogEntryForInstalled: id fallback is reserved for agent adoption', () => {
  const item = { id: 'pdf', repo: 'o/r', path: 'skills/pdf' }
  assert.equal(catalogEntryForInstalled([item], { id: 'pdf', provenance: 'agent' }), item)
  assert.equal(catalogEntryForInstalled([item], { id: 'pdf', provenance: 'seed' }), null)
})

test('catalogUpdateAvailability: platform capability gates managed updates but not agent adoption', () => {
  const digest = `sha256-tree-v1:${'a'.repeat(64)}`
  assert.deepEqual(
    catalogUpdateAvailability({ provenance: 'installed:o/r', treeDigest: digest, updateSupported: true }),
    { supported: true, reason: '' },
  )
  assert.match(
    catalogUpdateAvailability({
      provenance: 'installed:o/r', treeDigest: digest,
      updateSupported: false, updateUnsupportedReason: 'unfinished_transition',
    }).reason,
    /unfinished/i,
  )
  assert.equal(
    catalogUpdateAvailability({
      provenance: 'agent', is_dir: true, treeDigest: digest,
      updateSupported: false, updateUnsupportedReason: 'not_installer_managed',
    }).supported,
    true,
  )
  assert.match(
    catalogUpdateAvailability({ provenance: 'agent', is_dir: false, treeDigest: digest }).reason,
    /directory/i,
  )
  assert.match(
    catalogUpdateAvailability({
      provenance: 'installed:o/r', treeDigest: digest, sourceRef: 'stable',
      updateSupported: true,
    }, { ref: 'main' }).reason,
    /different catalog ref/i,
  )
  assert.equal(catalogUpdateAvailability({ provenance: 'seed', treeDigest: null }).supported, false)
})

test('catalogUpdatePayload: update source is nested and pinned to the reviewed commit', () => {
  const skill = {
    treeDigest: `sha256-tree-v1:${'a'.repeat(64)}`,
    provenance: 'agent',
    is_dir: true,
  }
  assert.deepEqual(
    catalogUpdatePayload(
      skill,
      { repo: 'o/r', ref: 'stable' },
      'skills/demo',
      'b'.repeat(40),
    ),
    {
      expected_tree_digest: skill.treeDigest,
      source: {
        kind: 'github', repo: 'o/r', path: 'skills/demo', ref: 'stable',
        commit: 'b'.repeat(40),
      },
      adopt: true,
    },
  )
})

test('catalogInstallPayload: v2 tracks the ref while older servers stay pinned', () => {
  const source = { repo: 'o/r', ref: 'stable' }
  const commit = 'b'.repeat(40)
  assert.deepEqual(catalogInstallPayload(source, 'skills/demo', commit, 2), {
    repo: 'o/r', path: 'skills/demo', ref: 'stable', expected_commit: commit,
  })
  assert.deepEqual(catalogInstallPayload(source, 'skills/demo', commit, 1), {
    repo: 'o/r', path: 'skills/demo', ref: commit,
  })
})

test('skillDisplayTitle: slugs become Title Case; real names pass through', () => {
  assert.equal(skillDisplayTitle('finding-skills'), 'Finding Skills')
  assert.equal(skillDisplayTitle('skill_creator'), 'Skill Creator')
  assert.equal(skillDisplayTitle('PDF Processing'), 'PDF Processing')
  assert.equal(skillDisplayTitle(''), 'Untitled skill')
  assert.equal(skillDisplayTitle(null), 'Untitled skill')
})

test('usageLabel: zero/invalid usage renders nothing, positive counts read naturally', () => {
  assert.equal(usageLabel(0), '')
  assert.equal(usageLabel(undefined), '')
  assert.equal(usageLabel(-2), '')
  assert.equal(usageLabel(7), '7× in 30d')
})

// --- classifyLink inside directory skills: relative links are resources ---

test('classifyLink(dirSkill): relative refs are bundled resources, not skill slugs', () => {
  assert.deepEqual(
    classifyLink('reference.md', { dirSkill: true }),
    { kind: 'resource', path: 'reference.md' },
  )
  assert.deepEqual(
    classifyLink('./scripts/fill.py', { dirSkill: true }),
    { kind: 'resource', path: 'scripts/fill.py' },
  )
  assert.equal(classifyLink('../escape.md', { dirSkill: true }).kind, 'blocked')
  assert.equal(classifyLink('/abs/path.md', { dirSkill: true }).kind, 'blocked')
  // Anchors and external links keep their normal classification.
  assert.equal(classifyLink('#section', { dirSkill: true }).kind, 'anchor')
  assert.equal(classifyLink('https://x.test/a', { dirSkill: true }).kind, 'external')
  // Legacy flat skills preserve the cross-skill slug convention.
  assert.deepEqual(classifyLink('other.md'), { kind: 'skill', slug: 'other' })
})

// --- mapSkillRows: shape, sorting, and retained install identity ---

test('mapSkillRows sorts by title and retains source identity and update capability', () => {
  const rows = mapSkillRows({ skills: [
    { id: 'zeta', name: 'zeta', description: 'z', provenance: 'seed', is_dir: false, uses_30d: 2 },
    { id: 'pdf', name: 'pdf', description: 'p', provenance: 'installed:o/r', is_dir: true,
      uses_30d: 0, commit: 'a'.repeat(40), source_repo: 'o/r', source_path: 'skills/pdf',
      source_ref: 'stable', update_supported: true },
    { id: '', name: 'dropped' },
  ] })
  assert.deepEqual(rows.map((r) => r.id), ['pdf', 'zeta'])
  assert.equal(rows[0].commit, 'a'.repeat(40))
  assert.equal(rows[0].sourceRepo, 'o/r')
  assert.equal(rows[0].sourcePath, 'skills/pdf')
  assert.equal(rows[0].sourceRef, 'stable')
  assert.equal(rows[0].updateSupported, true)
  assert.equal(rows[0].updateUnsupportedReason, null)
  assert.equal(rows[1].commit, null)
  assert.equal(rows[1].updateSupported, false)
})

test('mapSkillRows retains the platform update refusal reason', () => {
  const [row] = mapSkillRows({ skills: [{
    id: 'demo', update_supported: false,
    update_unsupported_reason: 'unverified_identity',
  }] })
  assert.equal(row.updateSupported, false)
  assert.equal(row.updateUnsupportedReason, 'unverified_identity')
})

test('mapSkillRows carries the authoritative installer files inventory (or null)', () => {
  const [withFiles, withoutFiles] = mapSkillRows({ skills: [
    { id: 'a', name: 'a', files: ['SKILL.md', 'scripts/fill.py'] },
    { id: 'b', name: 'b' }, // no record → null, so the caller falls back to the walk
  ] })
  assert.deepEqual(withFiles.files, ['SKILL.md', 'scripts/fill.py'])
  assert.equal(withoutFiles.files, null)
  // A malformed (non-array) files field degrades to null, never a bad verdict.
  const [bad] = mapSkillRows({ skills: [{ id: 'c', name: 'c', files: 'oops' }] })
  assert.equal(bad.files, null)
})

test('mapSkillRows retains the tree digest used for update compare-and-swap', () => {
  const [row] = mapSkillRows({ skills: [{
    id: 'demo', name: 'demo', tree_digest: 'sha256-tree-v1:abc',
  }] })
  assert.equal(row.treeDigest, 'sha256-tree-v1:abc')
})

test('mergeConfirmedSkill makes a successful install authoritative before refresh', () => {
  const existing = mapSkillRows({ skills: [
    { id: 'alpha', name: 'Alpha', provenance: 'seed' },
  ] })
  const merged = mergeConfirmedSkill(existing, {
    id: 'pdf',
    name: 'PDF',
    description: 'Read PDFs',
    provenance: 'installed:anthropics/skills',
    is_dir: true,
    files: ['SKILL.md'],
  })
  assert.deepEqual(merged.map((row) => row.id), ['alpha', 'pdf'])
  assert.equal(merged[1].provenance, 'installed:anthropics/skills')

  const refreshed = mergeConfirmedSkill(merged, {
    id: 'pdf',
    name: 'PDF tools',
    description: 'Updated canonical row',
    provenance: 'installed:anthropics/skills',
    is_dir: true,
    files: ['SKILL.md', 'references.md'],
  })
  assert.equal(refreshed.filter((row) => row.id === 'pdf').length, 1)
  assert.equal(refreshed.find((row) => row.id === 'pdf').description, 'Updated canonical row')
})

// --- createSkillsLoader: newest-generation-wins for the primary list ---

test('createSkillsLoader: a slow older response reports applied=false', async () => {
  const gates = []
  const fetchImpl = () => new Promise((resolve) => {
    gates.push(() => resolve({
      ok: true,
      json: async () => ({ skills: [{ id: `req-${gates.length}`, name: 'x' }] }),
    }))
  })
  const loader = createSkillsLoader({ fetchImpl })
  const first = loader.load({})
  const second = loader.load({})
  gates[1]() // the NEWER request resolves first…
  const b = await second
  assert.equal(b.applied, true)
  gates[0]() // …and the older one must not be applied
  const a = await first
  assert.equal(a.applied, false)
  assert.equal(a.ok, true) // it succeeded — it is just superseded
})

test('createSkillsLoader: retains the negotiated install contract version', async () => {
  const loader = createSkillsLoader({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ skills: [], install_contract: { version: 2 } }),
    }),
  })
  const result = await loader.load({})
  assert.equal(result.installContractVersion, 2)
})

test('createSkillsLoader: errors are also generation-gated and invalidate() supersedes', async () => {
  let reject
  const fetchImpl = () => new Promise((_, rej) => { reject = rej })
  const loader = createSkillsLoader({ fetchImpl })
  const p = loader.load({})
  loader.invalidate()
  reject(new Error('boom'))
  const res = await p
  assert.equal(res.ok, false)
  assert.equal(res.applied, false) // stale failure cannot overwrite newer state
})

test('createSkillsLoader: a missing v2 route falls back to legacy browsing mode', async () => {
  const fetchImpl = async (url) => {
    if (url === '/api/skills') return { ok: false, status: 404 }
    if (url === '/api/storage/shared-list/skills/?limit=200') {
      return {
        ok: true,
        json: async () => ({
          entries: [
            { name: 'cron.md', type: 'file' },
            { name: '.seed-version', type: 'file' },
          ],
          next_cursor: null,
        }),
      }
    }
    if (url === '/api/storage/shared/skills/cron.md') {
      return { ok: true, text: async () => '# Cron\n\nSchedule recurring work.' }
    }
    throw new Error(`unexpected ${url}`)
  }
  const result = await createSkillsLoader({ fetchImpl }).load({})
  assert.equal(result.ok, true)
  assert.equal(result.applied, true)
  assert.equal(result.mode, 'legacy')
  assert.equal(result.installContractVersion, 0)
  assert.deepEqual(result.rows.map((row) => row.id), ['cron'])
  assert.equal(result.rows[0].description, 'Schedule recurring work.')
  assert.equal(result.rows[0].files, null)
})

test('loadLegacySkills: reads directory-shaped SKILL.md skills too', async () => {
  const fetchImpl = async (url) => {
    if (url === '/api/storage/shared-list/skills/?limit=200') {
      return {
        ok: true,
        json: async () => ({
          entries: [{ name: 'pdf-tools', type: 'directory' }],
          next_cursor: null,
        }),
      }
    }
    if (url === '/api/storage/shared-list/skills/pdf-tools/?limit=200') {
      return {
        ok: true,
        json: async () => ({
          entries: [
            { name: 'SKILL.md', type: 'file' },
            { name: 'reference.md', type: 'file' },
          ],
          next_cursor: null,
        }),
      }
    }
    if (url === '/api/storage/shared/skills/pdf-tools/SKILL.md') {
      return { ok: true, text: async () => '# PDF Tools\n\nWork with PDFs.' }
    }
    throw new Error(`unexpected ${url}`)
  }
  const [row] = await loadLegacySkills(fetchImpl, {})
  assert.equal(row.id, 'pdf-tools')
  assert.equal(row.is_dir, true)
  assert.equal(row.title, 'PDF Tools')
})
