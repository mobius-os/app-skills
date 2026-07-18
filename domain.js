// Pure, dependency-free helpers for the Skills app — no React, no I/O, no DOM.
// This is the testable core (see test/domain.test.js); index.jsx imports it.
// Keeping the parsing and link-classification logic here means they can be
// unit-tested without bundling react/marked/dompurify.

function splitFrontmatter(content) {
  const text = content || ''
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { body: text, meta: {} }
  const meta = {}
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      const body = lines.slice(i + 1).join('\n').replace(/^\n+/, '')
      return { body, meta }
    }
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/)
    if (m) meta[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, '').trim()
  }
  return { body: text, meta: {} }
}

// Parse a skill's markdown into a display title + one-line description.
// Skill files are usually "# Title\n\n<description paragraph>...", but
// installed Codex skills may carry YAML frontmatter. Strip that metadata from
// the rendered body so the detail view reads like documentation, not a raw file.
// Fenced code blocks are tracked so a `# comment` or a fence marker INSIDE a
// code block is never mistaken for the title or the description.
export function parseSkill(name, content) {
  const slug = name.replace(/\.md$/, '')
  const { body: text, meta } = splitFrontmatter(content)
  const lines = text.split('\n')
  const isFence = (l) => /^\s*(```|~~~)/.test(l)
  let title = ''
  let descStart = 0
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    const m = lines[i].match(/^#\s+(.+?)\s*$/)
    if (m) { title = m[1].trim(); descStart = i + 1; break }
  }
  if (!title) title = meta.name || slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  let description = ''
  inFence = false
  for (let i = descStart; i < lines.length; i++) {
    if (isFence(lines[i])) { inFence = !inFence; if (description) break; else continue }
    if (inFence) continue
    const l = lines[i].trim()
    if (!l) { if (description) break; else continue }
    if (/^#{1,6}\s/.test(l) || l === '---') { if (description) break; else continue }
    description += (description ? ' ' : '') + l
    if (description.length > 240) break
  }
  return {
    slug,
    name,
    title,
    description: description.trim() || meta.description || '',
    content: text,
  }
}

// Classify a link tapped inside a rendered skill so the detail view never lets
// the iframe navigate away (the whole app document lives in that iframe, so a
// raw navigation bricks the view until remount). Returns one of:
//   { kind: 'skill', slug }   — a same-folder `.md` link → open in-app
//   { kind: 'external', url } — an http/https link → open in a new browser tab
//   { kind: 'anchor' }        — an in-page `#fragment` → harmless, leave default
//   { kind: 'blocked', ... }  — anything else (other protocol, sub-path) → do not navigate
export function classifyLink(href) {
  const raw = (href || '').trim()
  if (!raw) return { kind: 'blocked', reason: 'empty' }
  if (raw.startsWith('#')) return { kind: 'anchor' }
  const schemeMatch = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase()
    if (scheme === 'http' || scheme === 'https') return { kind: 'external', url: raw }
    // Every other protocol (mailto:, tel:, javascript:, data:, file:, …) is
    // unsupported inside the sandbox — block it rather than navigate.
    return { kind: 'blocked', reason: 'protocol', scheme }
  }
  // No scheme → a relative link. Only a same-folder `.md` (optionally `./name.md`)
  // maps to another skill; a sub-path or bare relative link has no in-app target.
  const path = raw.split(/[?#]/)[0]
  const md = path.match(/^(?:\.\/)?([^/\\]+)\.md$/i)
  if (md) {
    let slug
    try { slug = decodeURIComponent(md[1]) } catch { slug = md[1] }
    return { kind: 'skill', slug }
  }
  return { kind: 'blocked', reason: 'relative', path }
}

// Pick the installed apps that contribute an always-on system-prompt fragment.
// GET /api/apps/ already omits soft-deleted apps, so no tombstone check belongs
// here. Sorting makes the read-only section stable regardless of install order.
export function selectSystemPromptApps(apps) {
  if (!Array.isArray(apps)) return []
  return apps
    .filter((app) => app?.system_app === true && Boolean(app.system_prompt_file))
    .sort((a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()))
}

// Turn a developer-facing fetch error into copy the owner can act on.
export function friendlyLoadError(err) {
  const raw = String((err && err.message) || err || '')
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(raw)) {
    return 'Couldn’t reach shared storage. Check your connection and try again.'
  }
  if (/^list \d/i.test(raw) || /\b5\d\d\b/.test(raw)) {
    return 'Shared storage returned an error. Try again in a moment.'
  }
  return raw || 'Something went wrong loading skills.'
}

// Manages the shell back-sentinel lifecycle for ONE detail level and closes the
// double-tap-during-pending-push race. A handle from nav.open is only a LIVE
// sentinel once its `.ready` resolves TRUE; until then a second open() must not
// render detail (there is no sentinel yet to pop) nor stack a second handle —
// it retargets the in-flight open, which renders whatever key was requested
// last once its handle resolves. onShow(key) opens or swaps detail content;
// onClose() returns to the list; getNavOpen() resolves window.mobius.nav.open at
// call time (the runtime may not be present at mount). Pure of React.
//
// The nav contract (locked by mobius-runtime's own tests): `handle.ready`
// RESOLVES to true (shell owns the back target) or false (push refused / timed
// out) — it does NOT reject. On false we still show the content (blocking the
// detail on a refused back target is worse UX), but we DROP our handle so
// close()/isOpen() never claim to own a sentinel the shell doesn't have, and no
// phantom nav-pop is sent. (An older runtime with no `.ready` resolves
// undefined → treated as owned, best-effort.)
export function createDetailNav({ getNavOpen, label, onShow, onClose }) {
  let handle = null
  let ready = false
  let pending = null
  function reset() { handle = null; ready = false; pending = null }

  async function open(key) {
    if (handle && ready) { onShow(key); return }          // detail open — swap content
    if (handle) { pending = key; return }                 // push in flight — retarget only
    const navOpen = typeof getNavOpen === 'function' ? getNavOpen() : null
    if (typeof navOpen !== 'function') { onShow(key); return } // no shell nav — open directly
    let h
    try { h = navOpen(label, () => { reset(); onClose() }) } catch { h = null }
    if (!h) { onShow(key); return }
    handle = h; ready = false; pending = key
    // ready resolves true/false; a defensive catch only guards a broken runtime
    // that throws (treated as "not owned"), never the normal refused-push path.
    let owned
    try { owned = await h.ready } catch { owned = false }
    if (handle !== h) return                               // superseded by another open/close
    const key2 = pending || key
    if (owned === false) {
      // Shell refused the back target: show the content but own NO sentinel, so
      // close()/isOpen() stay honest and device back falls through to the shell.
      reset()
      onShow(key2)
      return
    }
    ready = true
    onShow(key2)                                           // render the LATEST requested key
  }

  function close() {
    try { handle && handle.close && handle.close() } catch {}
    reset()
    onClose()
  }

  return { open, close, isOpen: () => handle != null }
}
