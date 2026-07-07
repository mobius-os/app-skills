// Pure, dependency-free helpers for the Skills app — no React, no I/O, no DOM.
// This is the testable core (see test/domain.test.js); index.jsx imports it.
// Keeping the parsing and link-classification logic here means they can be
// unit-tested without bundling react/marked/dompurify.

// Parse a skill's markdown into a display title + one-line description.
// Skill files are "# Title\n\n<description paragraph>..." with no frontmatter.
// Fenced code blocks are tracked so a `# comment` or a fence marker INSIDE a
// code block is never mistaken for the title or the description.
export function parseSkill(name, content) {
  const slug = name.replace(/\.md$/, '')
  const text = content || ''
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
  if (!title) title = slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
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
  return { slug, name, title, description: description.trim(), content: text }
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
