// Dependency-free core for the catalog screen — the curated source list,
// git-trees scan filtering, SKILL.md summary parsing, and the background
// summary prefetch pool. No React and no direct network: fetching is injected
// by index.jsx (which routes it through /api/proxy), so everything here is
// unit-testable (see test/catalog.test.js).

import { parseSkill, splitFrontmatter } from './domain.js'

// Verified catalogs that HOST SKILL.md-format skills — link-list "awesome"
// repos don't render here (nothing installable to scan); hand those to the
// agent instead. `path` scopes the tree scan to a subtree; '' scans the whole
// repo. The list is app data too: a sources.json in app storage overrides it,
// so "add this repo as a source" is a chat request, not a code change.
export const DEFAULT_SOURCES = [
  { label: 'Anthropic Skills', repo: 'anthropics/skills', path: 'skills', ref: 'main',
    blurb: 'Official Anthropic skills — documents, artifacts, MCP building, testing.' },
  { label: 'Anthropic Knowledge Work', repo: 'anthropics/knowledge-work-plugins', path: '', ref: 'main',
    blurb: 'Anthropic’s knowledge-worker plugins — research, bio, finance, legal, and more.' },
  { label: 'Superpowers', repo: 'obra/superpowers', path: 'skills', ref: 'main',
    blurb: 'The famous dev-methodology set — brainstorming, planning, TDD, debugging.' },
  { label: 'Trail of Bits Security', repo: 'trailofbits/skills', path: '', ref: 'main',
    blurb: 'Security research, vulnerability detection, and audit workflows.' },
  { label: 'Cloudflare', repo: 'cloudflare/skills', path: 'skills', ref: 'main',
    blurb: 'Official Cloudflare skills for building on Workers and the CF platform.' },
  { label: 'Hermes bundled', repo: 'NousResearch/hermes-agent', path: 'skills', ref: 'main',
    blurb: 'Nous Research’s always-on Hermes agent skills.' },
  { label: 'Hermes optional', repo: 'NousResearch/hermes-agent', path: 'optional-skills', ref: 'main',
    blurb: 'The big Hermes catalog — blockchain, research, media, agents, and more.' },
]

// Includes `ref`: two sources sharing a repo+path but pinned to different refs
// (e.g. `main` vs a tag) are distinct scans and must not share cache/React-key
// state, or one ref's summaries could render under the other.
export function sourceKey(source) {
  return `${source?.repo || ''}/${source?.path || ''}@${source?.ref || 'main'}`
}

// Same shapes the backend installer/catalog accept.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const REF_RE = /^[A-Za-z0-9._/-]{1,100}$/

// Bound + validate a sources.json override before anything renders or builds
// URLs from it: malformed or hostile entries are dropped, the list is capped,
// and every field is forced into the installer's repo/path/ref shapes.
// Returns [] when nothing survives — the caller keeps DEFAULT_SOURCES.
export function normalizeSources(raw, { max = 12 } = {}) {
  const out = []
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= max) break
    if (!entry || typeof entry !== 'object') continue
    const repo = String(entry.repo || '')
    if (!REPO_RE.test(repo)) continue
    const path = String(entry.path || '').replace(/^\/+|\/+$/g, '')
    // Mirror the backend control-char check (catalog_index.normalize_sources):
    // path text flows into URL builders, so a control character must not slip
    // through even though the app also encodes segments downstream.
    if (
      path.length > 200 ||
      path.split('/').includes('..') ||
      path.includes('\\') ||
      /[\u0000-\u001f]/.test(path)
    ) continue
    const ref = String(entry.ref || 'main')
    if (!REF_RE.test(ref) || ref.includes('..')) continue
    const label = String(entry.label || repo).replace(/\s+/g, ' ').trim().slice(0, 80)
    const blurb = typeof entry.blurb === 'string' ? entry.blurb.slice(0, 200) : ''
    out.push({ label, repo, path, ref, ...(blurb ? { blurb } : {}) })
  }
  return out
}

// One recursive git-trees call finds every SKILL.md in the repo — flat cards,
// no folder drilling, no dead ends. This filters the raw tree down to skill
// directories under the source's path prefix.
export function treeToSkills(tree, pathPrefix) {
  const prefix = String(pathPrefix || '').replace(/^\/+|\/+$/g, '')
  const entries = Array.isArray(tree) ? tree : []
  const skills = entries
    .filter((t) => typeof t?.path === 'string' && t.path.endsWith('/SKILL.md'))
    .map((t) => t.path.slice(0, -'/SKILL.md'.length))
    .filter((dir) => !prefix || dir === prefix || dir.startsWith(`${prefix}/`))
    // `id` is what an install of this card will actually be named — compare
    // installed-ness and duplicates against it, never the cased basename.
    // `installable` is false when the id violates the backend name contract
    // (installIdOf → null), so such a card renders unsupported instead of
    // firing an install that 400s.
    .map((dir) => {
      const name = dir.split('/').pop()
      const id = installIdOf(name)
      return { dir, name, id, installable: id != null }
    })
  // COLLISION: two distinct directories normalizing to one install id (e.g.
  // `PDF/SKILL.md` + `pdf/SKILL.md`) can't be a trustworthy one-card→one-install
  // mapping — before either installs both actions are live, and after one both
  // read "Installed". Mark every colliding card non-installable so the owner
  // resolves it deliberately rather than racing two installs of the same id.
  const counts = new Map()
  for (const s of skills) {
    if (s.id != null) counts.set(s.id, (counts.get(s.id) || 0) + 1)
  }
  for (const s of skills) {
    if (s.id != null && counts.get(s.id) > 1) {
      s.installable = false
      s.collision = true
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

// A raw SKILL.md → what the card shows. Frontmatter `description` is the
// ecosystem's "when to use this" line, so it wins over the first body
// paragraph; parseSkill supplies the fence-aware fallback and the
// frontmatter-stripped body for the peek.
export function catalogSummary(text) {
  const { meta } = splitFrontmatter(text || '')
  const parsed = parseSkill('SKILL.md', text || '')
  return {
    description: meta.description || parsed.description || 'No description in SKILL.md.',
    license: meta.license || null,
    peek: (parsed.content || '').trim().slice(0, 700) || null,
  }
}

// Mirror of the backend's install bounds (backend/app/routes/skills.py —
// _RESOURCE_COUNT_MAX / _RESOURCE_TOTAL_MAX / _RESOURCE_MAX_DEPTH /
// _RESOURCE_SUFFIXES). Advisory display only: the backend enforces for real,
// this just predicts what it will do so the badge can warn before install.
export const INSTALL_LIMITS = {
  maxFiles: 24,
  maxTotalBytes: 2 * 1024 * 1024,
  // The backend caps the fetched SKILL.md itself (manifest_contract.
  // SKILL_MAX_BYTES = 256 KiB). A larger entry document doesn't install whole,
  // so the badge must warn instead of showing a false green.
  skillMaxBytes: 256 * 1024,
  // Maximum PATH SEGMENTS per resource, exactly the backend's
  // _RESOURCE_MAX_DEPTH semantics (`a/b/c/file.md` = 4 segments = at the cap).
  maxDepth: 4,
  suffixes: ['.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.py', '.js', '.ts',
    '.sh', '.toml', '.html', '.css'],
}

const SCRIPT_SUFFIXES = ['.py', '.js', '.ts', '.sh']

function suffixOf(path) {
  const base = path.split('/').pop() || ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

// EXACT mirror of the backend's per-file rule (_resource_rel_ok): 1..4 plain
// segments — none empty, dot-prefixed, or containing a backslash — plus the
// suffix allowlist. The badge must never say "works" for a file the real
// installer will drop.
export function resourceRelOk(rel) {
  const segments = String(rel || '').split('/')
  if (segments.length < 1 || segments.length > INSTALL_LIMITS.maxDepth) return false
  for (const seg of segments) {
    if (!seg || seg.startsWith('.') || seg.includes('\\')) return false
  }
  return INSTALL_LIMITS.suffixes.includes(suffixOf(rel))
}

// The backend skill-name contract (routes/skills._SKILL_NAME_OK): lowercase,
// no leading punctuation, no traversal/space/markup. A derived id that doesn't
// match is one the installer will 400, so it must never be presented as
// installable.
export const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/

// What the installer will actually name a skill: lowercased basename (backend
// _derive_name), but ONLY if it satisfies the name contract. Returns null for
// a name the backend would reject (spaces, `#`, `?`, `%`, leading punctuation,
// non-ASCII, …) so the card can be rendered unsupported with Install disabled
// instead of offering an install that inevitably 400s. Installed checks and
// duplicate detection compare THIS id, never the cased basename.
export function installIdOf(name) {
  const id = String(name || '').toLowerCase()
  return SKILL_ID_RE.test(id) ? id : null
}

// Relative paths mentioned in SKILL.md — markdown links/images plus bare
// inline-code paths like `scripts/helper.py`. External URLs and anchors are
// not the skill's files, so they're skipped.
export function relativeRefs(raw) {
  const refs = new Set()
  const consider = (target, { needsSlash } = {}) => {
    const t = String(target || '').trim().replace(/^\.\//, '').split(/[#?]/)[0]
    if (!t || t.startsWith('/') || t.startsWith('~') || t.includes('..') || /^[a-z][a-z0-9+.-]*:/i.test(t)) return
    // A shell snippet (`open /tmp/x.html`) or home path is not a bundled file.
    if (/\s/.test(t)) return
    if (needsSlash && !t.includes('/')) return
    // Files only — a trailing dir ref like `scripts/` isn't checkable.
    if (/\.[a-z0-9]{1,6}$/i.test(t)) refs.add(t)
  }
  for (const m of String(raw || '').matchAll(/!?\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) consider(m[1])
  // Inline code must be path-shaped (`scripts/helper.py`) — a bare `foo.json`
  // is usually a generic mention, not a bundled file.
  for (const m of String(raw || '').matchAll(/`([^`\n]+\.[a-z0-9]{1,5})`/gi)) consider(m[1], { needsSlash: true })
  return [...refs]
}

// Predict how POST /api/skills/install would treat a catalog skill, from data
// the screen already holds: the source's recursive git tree and the raw
// SKILL.md. Returns { ok, caveats: [{ kind, text }] } — ok means "installs
// whole and indexes cleanly", caveats are ordered most→least serious.
export function assessCompat(tree, dir, raw) {
  const caveats = []
  const prefix = `${String(dir || '').replace(/\/+$/g, '')}/`
  const files = (Array.isArray(tree) ? tree : [])
    .filter((t) => t?.type === 'blob' && typeof t?.path === 'string' && t.path.startsWith(prefix))
    .map((t) => ({ rel: t.path.slice(prefix.length), size: Number(t.size) || 0 }))

  const kept = []
  const dropped = []
  let skillBytes = 0
  for (const f of files) {
    if (/^skill\.md$/i.test(f.rel)) { skillBytes = f.size; continue }
    ;(resourceRelOk(f.rel) ? kept : dropped).push(f)
  }
  // The tree blob size is the authoritative byte count; fall back to the raw
  // text's UTF-8 length when the tree omits it.
  if (!skillBytes && raw) {
    skillBytes = typeof TextEncoder !== 'undefined'
      ? new TextEncoder().encode(String(raw)).length
      : String(raw).length
  }
  // Most serious: the entry document itself is over the fetch cap, so the
  // instructions won't install whole.
  if (skillBytes > INSTALL_LIMITS.skillMaxBytes) {
    caveats.push({
      kind: 'skill-too-large',
      text: `Its SKILL.md is larger than Möbius's ${Math.round(INSTALL_LIMITS.skillMaxBytes / 1024)} KB limit (${(skillBytes / 1024).toFixed(0)} KB), so the instructions may not install completely.`,
    })
  }

  // Install materializes resources in order and stops adding once over budget;
  // predicting the exact survivors would overfit, so over-budget is its own
  // "installs partially" caveat instead.
  const total = kept.reduce((n, f) => n + f.size, 0)
  const overCount = kept.length > INSTALL_LIMITS.maxFiles
  const overSize = total > INSTALL_LIMITS.maxTotalBytes

  // A ref is broken when it names a file the install will drop, or a file the
  // tree scan proves doesn't exist in the skill dir at all.
  const keptSet = new Set(kept.map((f) => f.rel))
  const brokenRefs = relativeRefs(raw).filter(
    (r) => !keptSet.has(r) && !/^skill\.md$/i.test(r),
  )
  if (brokenRefs.length) {
    caveats.push({
      kind: 'broken-refs',
      text: `Its instructions mention files that won't be there after install (${nameSome(brokenRefs)}), so the steps that use them may not work.`,
    })
  }
  if (dropped.length) {
    caveats.push({
      kind: 'dropped',
      text: `${dropped.length} extra ${dropped.length === 1 ? 'file' : 'files'} won't be copied — Möbius only installs common text files, and ${dropped.length === 1 ? 'this one is' : 'these are'} a different type or buried too deep: ${nameSome(dropped.map((f) => f.rel))}. The main instructions still install fine.`,
    })
  }
  if (overCount || overSize) {
    const parts = []
    if (overCount) parts.push(`${kept.length} files (max ${INSTALL_LIMITS.maxFiles})`)
    if (overSize) parts.push(`${(total / (1024 * 1024)).toFixed(1)} MB (max ${INSTALL_LIMITS.maxTotalBytes / (1024 * 1024)} MB)`)
    caveats.push({
      kind: 'over-budget',
      text: `This skill is bigger than Möbius's install limit — ${parts.join(', ')} — so only part of it will be copied.`,
    })
  }

  const scripts = kept.filter((f) => SCRIPT_SUFFIXES.includes(suffixOf(f.rel)))
  if (scripts.length) {
    caveats.push({
      kind: 'scripts',
      text: `Comes with ${scripts.length} helper ${scripts.length === 1 ? 'script' : 'scripts'}. Möbius saves them for the agent to read — nothing runs automatically.`,
    })
  }

  const fm = frontmatterCaveat(raw)
  if (fm) caveats.push(fm)

  return { ok: caveats.length === 0, caveats }
}

// Caveats the backend treats as a HARD reject rather than a partial install:
// the install cannot succeed at all, so the skill must present as unsupported
// (Install disabled) — never an amber-but-runnable action. A SKILL.md over the
// fetch cap is rejected outright by the installer; the rest (dropped resources,
// over-budget, scripts, missing summary) still install, just partially.
export const BLOCKING_CAVEATS = new Set(['skill-too-large'])

// One closed installability result for a catalog entry — the SINGLE source the
// Install control derives from, never the mere presence of a compat object:
//   'loading'      compat verdict not computed yet
//   'unsupported'  can never install cleanly (invalid/duplicate id, or a
//                  blocking compat caveat from the same hard contract as the
//                  backend) — Install disabled, with `reason`/`chip` to show
//   'installable'  safe to offer
export function installability(skill, compat) {
  if (skill && skill.installable === false) {
    return {
      status: 'unsupported',
      reason: skill.collision
        ? `Another directory in this source also installs as "${skill.id}", so neither can be installed cleanly — ask the agent to pick one.`
        : 'This name isn’t valid for a Möbius skill (lowercase letters, digits, and . _ - only), so it can’t be installed here.',
      chip: skill.collision ? 'Duplicate id' : 'Unsupported name',
    }
  }
  if (!compat) return { status: 'loading', reason: '', chip: '' }
  const blocking = compat.caveats.find((c) => BLOCKING_CAVEATS.has(c.kind))
  if (blocking) return { status: 'unsupported', reason: blocking.text, chip: 'Too large' }
  return { status: 'installable', reason: '', chip: '' }
}

// Both flat parsers (here and backend) read only `key: value` scalars, so a
// YAML block scalar (`description: >`) leaves just the indicator behind.
function frontmatterCaveat(raw) {
  const desc = String(splitFrontmatter(raw || '').meta.description || '').trim()
  if (desc && !/^[>|][+-]?$/.test(desc)) return null
  return {
    kind: 'frontmatter',
    text: 'Missing its one-line summary, so skill lists will show its first paragraph instead. Purely cosmetic.',
  }
}

// The same verdict for an already-INSTALLED skill, from what's actually on
// disk: `files` is the installed resource list relative to the skill dir
// (empty for flat skills). The repo-side caveats (dropped, over-budget) are
// install-time facts we can no longer see — their lasting symptom is a
// reference to a file that isn't there, which this does catch.
export function assessInstalled(files, raw) {
  const caveats = []
  const rels = (Array.isArray(files) ? files : [])
    .map((f) => String(f || ''))
    .filter((r) => r && !/^skill\.md$/i.test(r))
  const have = new Set(rels)

  const broken = relativeRefs(raw).filter((r) => !have.has(r) && !/^skill\.md$/i.test(r))
  if (broken.length) {
    caveats.push({
      kind: 'broken-refs',
      text: `Its instructions mention files that aren't installed (${nameSome(broken)}), so the steps that use them may not work.`,
    })
  }

  const scripts = rels.filter((r) => SCRIPT_SUFFIXES.includes(suffixOf(r)))
  if (scripts.length) {
    caveats.push({
      kind: 'scripts',
      text: `Comes with ${scripts.length} helper ${scripts.length === 1 ? 'script' : 'scripts'}. Möbius saves them for the agent to read — nothing runs automatically.`,
    })
  }

  const fm = frontmatterCaveat(raw)
  if (fm) caveats.push(fm)

  return { ok: caveats.length === 0, caveats }
}

function nameSome(names, cap = 4) {
  const shown = names.slice(0, cap).join(', ')
  return names.length > cap ? `${shown}, +${names.length - cap} more` : shown
}

// The mutable ref (main, a tag) resolves to an immutable commit OID once per
// scan; the tree listing, every SKILL.md preview, the GitHub page link, and
// the install POST all name that OID. What the owner reviews is provably what
// installs, even if the source repo moves mid-browse.
export function resolveCommitUrl(source) {
  return `https://api.github.com/repos/${source.repo}/commits/${encodeURIComponent(source.ref || 'main')}`
}

export function commitOidOf(payload) {
  const sha = payload && typeof payload.sha === 'string' ? payload.sha : ''
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null
}

// Scoped to the source's subtree via git's `<oid>:<path>` rev syntax — one
// request, and a large repo outside the path can't push the listing into
// GitHub's truncation.
export function treeScanUrl(source, oid) {
  const at = oid || source.ref || 'main'
  const spec = source.path ? `${at}:${source.path.replace(/^\/+|\/+$/g, '')}` : at
  return `https://api.github.com/repos/${source.repo}/git/trees/${encodeURIComponent(spec)}?recursive=1`
}

// A scoped tree's paths are subtree-relative; everything downstream (skill
// dirs, compat assessment, install coordinates) speaks repo-relative paths,
// so re-prefix once at the scan boundary.
export function prefixTree(tree, pathPrefix) {
  const prefix = String(pathPrefix || '').replace(/^\/+|\/+$/g, '')
  if (!prefix) return Array.isArray(tree) ? tree : []
  return (Array.isArray(tree) ? tree : []).map((e) =>
    e && typeof e.path === 'string' ? { ...e, path: `${prefix}/${e.path}` } : e,
  )
}

// Percent-encode a repo-relative path, one segment at a time so the `/`
// separators survive. The backend installer percent-encodes the same path
// (routes/skills._raw_url uses quote(..., safe='/')); without matching that
// here, a dir containing `#`, `?`, `%`, a space, or non-ASCII makes the app
// preview/assess ONE URL while the install fetches a DIFFERENT path — breaking
// the exact-preview/exact-install invariant even under a single pinned OID.
// `repo` is already validated to a safe charset (REPO_RE) and keeps its `/`.
export function encodePath(path) {
  return String(path == null ? '' : path)
    .split('/')
    .map(encodeURIComponent)
    .join('/')
}

export function rawSkillUrl(source, dir, oid) {
  const rev = encodePath(oid || source.ref || 'main')
  return `https://raw.githubusercontent.com/${source.repo}/${rev}/${encodePath(dir)}/SKILL.md`
}

export function githubSkillUrl(source, dir, oid) {
  const rev = encodePath(oid || source.ref || 'main')
  return `https://github.com/${source.repo}/blob/${rev}/${encodePath(dir)}/SKILL.md`
}

// Every installed file under shared/skills/<id>/, relative to the skill dir,
// via the NON-recursive shared-list API (`fetchJson(url)` is injected with
// auth by the caller and resolves to parsed JSON or null). Every path segment
// is URL-encoded — installed names may contain '.', and resources anything
// the installer allowed. Returns null ("no verdict") whenever the walk is
// incomplete: a failed page, a paginated directory, a directory too deep to
// enumerate, or the page budget running out with work left. Partial data must
// never be assessed as the complete skill.
export async function listInstalledFiles(fetchJson, id, {
  maxPages = 16,
  maxDepth = INSTALL_LIMITS.maxDepth,
} = {}) {
  const enc = (rel) => rel.split('/').map(encodeURIComponent).join('/')
  const queue = ['']
  const out = []
  let pages = 0
  while (queue.length) {
    if (pages >= maxPages) return null
    const sub = queue.shift()
    pages += 1
    const data = await fetchJson(
      `/api/storage/shared-list/${enc(`skills/${id}${sub ? `/${sub}` : ''}`)}?limit=200`,
    )
    if (!data || !Array.isArray(data.entries)) return null
    if (data.next_cursor) return null // a >200-entry directory: not walked whole
    for (const e of data.entries) {
      const name = String(e?.name || '')
      if (!name) continue
      const rel = sub ? `${sub}/${name}` : name
      if (e.type === 'directory') {
        // A dir whose FILES would exceed the depth cap can still hold content
        // we won't see — that is an unknown, not an implicit "empty".
        if (rel.split('/').length >= maxDepth) return null
        queue.push(rel)
      } else {
        out.push(rel)
      }
    }
  }
  return out
}

// Monotonic generation guard for the catalog's async flows: every new scan
// takes a token; any response holding a stale token must be dropped, never
// written into state that now belongs to a different source. Pure so the
// A→B reversed-response races are unit-testable.
export function createGenerationGuard() {
  let generation = 0
  return {
    next() { return ++generation },
    isCurrent(token) { return token === generation },
    cancel() { generation += 1 },
  }
}

// Background prefetch pool: after a scan, walk every dir through `loadOne`
// with bounded concurrency so all summaries are loaded before the owner
// scrolls to them (raw-file fetches — no GitHub API rate cost). start()
// supersedes any previous pool via a generation counter, so switching sources
// mid-prefetch strands the stale workers instead of racing them; cancel()
// stops without starting a new pool. `loadOne` must dedupe by dir itself —
// viewport-priority loads from the cards may race the pool.
export function createSummaryPrefetcher({ loadOne, concurrency = 5 }) {
  let generation = 0

  function start(dirs) {
    const gen = ++generation
    const queue = Array.isArray(dirs) ? [...dirs] : []
    let next = 0
    const worker = () => {
      if (gen !== generation) return
      const dir = queue[next++]
      if (dir === undefined) return
      Promise.resolve()
        .then(() => loadOne(dir))
        .then(worker, worker)
    }
    const workers = Math.min(concurrency, queue.length)
    for (let k = 0; k < workers; k++) worker()
  }

  function cancel() {
    generation += 1
  }

  return { start, cancel }
}
