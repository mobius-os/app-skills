import { useState, useEffect, useRef, useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { parseSkill, classifyLink, friendlyLoadError } from './domain.js'

// Skills — a read-only browser for the agent's skills (the SKILL-style
// markdown files under /data/shared/skills). Inspired by the Skills screen in
// Hermex. Skills are shared, owner-authored context; a mini-app can READ shared
// storage with its scoped token but not WRITE it, so creating/editing a skill
// is routed to the Möbius agent via a new chat rather than an in-app save.
//
// The pure parsing + link-classification logic lives in ./domain.js so it can
// be unit-tested without bundling react/marked/dompurify (see test/).

const CSS = `
/* mobius-ui:Root v1 — keep in sync; library candidate. */
.sk-root { position: relative; display: flex; flex-direction: column; height: 100%;
  overflow: hidden; background: var(--bg); color: var(--text); font-family: var(--font); }
.sk-scroll { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; }
/* /mobius-ui:Root */

/* mobius-ui:Header v1 — keep in sync; library candidate. */
.sk-header { flex: 0 0 auto; display: flex; align-items: center; gap: 12px; min-height: 48px;
  padding: 12px 16px; background: var(--surface); border-bottom: 1px solid var(--border); }
.sk-brand { display: flex; align-items: center; gap: 11px; min-width: 0; flex: 1; }
.sk-mark { flex: 0 0 auto; width: 30px; height: 30px; border-radius: 9px; display: flex;
  align-items: center; justify-content: center; font-size: 16px;
  background: color-mix(in srgb, var(--accent) 16%, transparent); }
.sk-title { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.015em; }
.sk-subtitle { display: block; margin-top: 1px; font-size: 12px; color: var(--muted); }
.sk-iconbtn { flex: 0 0 auto; width: 40px; height: 40px; display: inline-flex; align-items: center;
  justify-content: center; border-radius: 10px; border: 1px solid var(--border); background: var(--surface);
  color: var(--text); cursor: pointer; transition: background .14s ease, transform .1s ease; }
.sk-iconbtn:active { transform: scale(0.94); }
.sk-iconbtn:disabled { opacity: 0.5; cursor: default; }
.sk-iconbtn svg { width: 18px; height: 18px; }
.sk-iconbtn.is-spinning svg { animation: sk-spin 0.9s linear infinite; }
@keyframes sk-spin { to { transform: rotate(360deg); } }
/* /mobius-ui:Header */

/* search */
.sk-searchwrap { position: sticky; top: 0; z-index: 5; padding: 12px 16px 8px; background: var(--bg); }
.sk-search { position: relative; display: flex; align-items: center; }
.sk-search svg { position: absolute; left: 12px; width: 17px; height: 17px; color: var(--muted); pointer-events: none; }
.sk-input { width: 100%; box-sizing: border-box; min-height: 44px; padding: 11px 14px 11px 38px;
  background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 12px;
  outline: none; font-family: var(--font); font-size: 16px; }
.sk-input:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }

/* list */
.sk-list { display: flex; flex-direction: column; padding: 4px 12px 32px; }
.sk-row { display: flex; align-items: flex-start; gap: 13px; width: 100%; box-sizing: border-box;
  text-align: left; padding: 14px 8px; background: none; border: none; border-bottom: 1px solid var(--border-light, var(--border));
  color: var(--text); font-family: var(--font); cursor: pointer; }
.sk-row:last-child { border-bottom: none; }
.sk-row:active { background: color-mix(in srgb, var(--text) 5%, transparent); }
.sk-rowicon { flex: 0 0 auto; width: 40px; height: 40px; border-radius: 20px; display: flex;
  align-items: center; justify-content: center; font-size: 18px;
  background: color-mix(in srgb, var(--accent) 12%, transparent); }
.sk-rowbody { flex: 1; min-width: 0; }
.sk-rowname { font-size: 16px; font-weight: 650; letter-spacing: -0.01em; word-break: break-word; }
.sk-rowslug { font-size: 12px; color: var(--muted); font-family: var(--mono); margin-top: 1px; }
.sk-rowdesc { margin-top: 4px; font-size: 13.5px; line-height: 1.5; color: var(--muted);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.sk-rowtag { display: inline-block; margin-top: 5px; font-size: 11px; font-weight: 600; color: var(--danger);
  padding: 1px 7px; border-radius: 999px; border: 1px solid var(--danger); }
.sk-chev { flex: 0 0 auto; align-self: center; color: var(--muted); opacity: 0.6; }
.sk-chev svg { width: 18px; height: 18px; }

/* empty / status */
.sk-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px;
  margin: auto; padding: 56px 28px; color: var(--muted); }
.sk-empty-mark { width: 64px; height: 64px; margin-bottom: 8px; border-radius: 18px; display: flex;
  align-items: center; justify-content: center; font-size: 30px;
  background: color-mix(in srgb, var(--accent) 14%, transparent); }
.sk-empty-title { font-size: 17px; font-weight: 700; color: var(--text); }
.sk-empty-text { margin: 0; font-size: 14px; line-height: 1.6; max-width: 30ch; }
.sk-spinner { width: 26px; height: 26px; border-radius: 50%; border: 2.5px solid var(--border);
  border-top-color: var(--accent); animation: sk-spin 0.8s linear infinite; }
.sk-retry { margin-top: 6px; min-height: 40px; padding: 9px 18px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text); font-weight: 600; font-size: 14px; cursor: pointer; }

/* mobius-ui:SyncPill v2 — keep in sync; library candidate. SILENT WHEN HEALTHY:
   not mounted while online (never "Saving" / pending counts); plain "Offline"
   when offline; .is-error only for a failure the owner can act on. */
.sk-sync-pill { position: absolute; right: 12px; bottom: 12px; z-index: 40;
  display: inline-flex; align-items: center; padding: 6px 12px; border-radius: 999px;
  background: var(--surface); border: 1px solid var(--border); color: var(--muted);
  font-size: 11px; font-weight: 600; box-shadow: 0 2px 8px rgba(0,0,0,0.18); }
.sk-sync-pill.is-error { border-color: var(--danger); color: var(--danger); }
/* /mobius-ui:SyncPill */

/* detail */
.sk-detail-head { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 10px;
  padding: 12px 12px; background: var(--surface); border-bottom: 1px solid var(--border); }
.sk-back { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px; min-height: 40px; padding: 6px 12px 6px 8px;
  border-radius: 10px; border: none; background: none; color: var(--accent); font-family: var(--font);
  font-size: 15px; font-weight: 600; cursor: pointer; }
.sk-back svg { width: 20px; height: 20px; }
.sk-detail-title { font-size: 16px; font-weight: 700; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; flex: 1; }
.sk-md { padding: 18px 18px 48px; font-size: 15px; line-height: 1.65; max-width: 720px; margin: 0 auto; }
.sk-md h1 { font-size: 22px; font-weight: 750; letter-spacing: -0.02em; margin: 4px 0 12px; }
.sk-md h2 { font-size: 18px; font-weight: 700; margin: 26px 0 10px; padding-top: 6px; border-top: 1px solid var(--border-light, var(--border)); }
.sk-md h3 { font-size: 15.5px; font-weight: 700; margin: 20px 0 8px; }
.sk-md p { margin: 0 0 12px; }
.sk-md ul, .sk-md ol { margin: 0 0 12px; padding-left: 22px; }
.sk-md li { margin: 4px 0; }
.sk-md a { color: var(--accent); text-decoration: none; }
.sk-md code { font-family: var(--mono); font-size: 0.86em; background: color-mix(in srgb, var(--text) 8%, transparent);
  padding: 1px 5px; border-radius: 5px; word-break: break-word; }
.sk-md pre { background: var(--surface2, var(--surface)); border: 1px solid var(--border); border-radius: 10px;
  padding: 12px 14px; overflow-x: auto; margin: 0 0 14px; }
.sk-md pre code { background: none; padding: 0; font-size: 12.5px; line-height: 1.55; }
.sk-md blockquote { margin: 0 0 12px; padding: 2px 14px; border-left: 3px solid var(--accent);
  color: var(--muted); }
.sk-md table { border-collapse: collapse; width: 100%; margin: 0 0 14px; font-size: 13.5px; display: block; overflow-x: auto; }
.sk-md th, .sk-md td { border: 1px solid var(--border); padding: 7px 10px; text-align: left; }
.sk-md th { background: color-mix(in srgb, var(--text) 5%, transparent); font-weight: 650; }
.sk-md hr { border: none; border-top: 1px solid var(--border); margin: 20px 0; }
.sk-md img { max-width: 100%; }
`

const HAMMER = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m15 12-8.5 8.5a2.12 2.12 0 1 1-3-3L12 9"/><path d="M17.64 15 22 10.64"/><path d="m20.91 11.7-1.25-1.25c-.6-.6-.93-1.4-.93-2.25v-.86L16.01 4.6a5.56 5.56 0 0 0-3.94-1.64H9l.92.82A6.18 6.18 0 0 1 12 8.4v1.56l2 2h.86c.85 0 1.65.34 2.25.93l1.25 1.25"/></svg>
const REFRESH = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
const SEARCH = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
const CHEV = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
const BACK = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
const PLUS = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>

export default function SkillsApp({ appId, token }) {
  const [skills, setSkills] = useState(null) // null = never loaded; [] or [..] = last-known-good
  const [loadError, setLoadError] = useState(null) // user-facing copy for the latest failed load
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(null) // slug of open skill
  const [online, setOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true)
  const navRef = useRef(null)
  const readySignalledRef = useRef(false) // gate app_ready to the first successful load

  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token])

  // A failed refresh must NOT wipe the already-loaded list. load() keeps the
  // last-known-good `skills` on failure and only records `loadError`; the full
  // error empty state is reserved for the very first load (skills === null).
  async function load({ isRefresh = false } = {}) {
    try {
      const res = await fetch('/api/storage/shared-list/skills/', { headers: authHeaders })
      if (!res.ok) throw new Error(`list ${res.status}`)
      const { entries } = await res.json()
      const files = (entries || []).filter((e) => e.type === 'file' && e.name.endsWith('.md') && !e.name.startsWith('.'))
      const parsed = await Promise.all(files.map(async (e) => {
        try {
          const r = await fetch(`/api/storage/shared/skills/${encodeURIComponent(e.name)}`, { headers: authHeaders })
          if (!r.ok) {
            // A per-file failure used to render a blank skill and emit nothing,
            // so a corrupt/permission-broken file looked intentionally empty.
            window.mobius?.signal?.('error', { message: `skill ${e.name} ${r.status}`, source: 'skill_load', status: r.status })
            return { ...parseSkill(e.name, ''), unavailable: true }
          }
          return parseSkill(e.name, await r.text())
        } catch (err) {
          window.mobius?.signal?.('error', { message: String(err?.message || err), source: 'skill_load', status: 0 })
          return { ...parseSkill(e.name, ''), unavailable: true }
        }
      }))
      parsed.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()))
      setSkills(parsed)
      setLoadError(null)
      if (!readySignalledRef.current) {
        readySignalledRef.current = true
        window.mobius?.signal?.('app_ready', { item_count: parsed.length })
      }
    } catch (err) {
      setLoadError(friendlyLoadError(err))
      window.mobius?.signal?.('error', { message: String(err?.message || err), source: isRefresh ? 'refresh' : 'load' })
      // Keep the last-known-good list intact; on the first load skills stays null.
    }
  }

  useEffect(() => { load() }, []) // shared storage has no subscribe(); refresh is explicit

  async function refresh() {
    setRefreshing(true)
    await load({ isRefresh: true })
    setRefreshing(false)
  }

  // Track connectivity for the Offline pill (silent-sync: pill only when offline).
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    if (typeof window.mobius?.online === 'boolean') setOnline(window.mobius.online)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  function showSkill(slug) {
    setSelected(slug)
    window.mobius?.signal?.('item_opened', { type: 'skill', slug })
  }

  // Android/browser back for the detail drill-down. Follows building-apps.md's
  // await-ready protocol: install the back sentinel, await handle.ready, and
  // only render detail if this handle is still the current one. On rejection we
  // clear navRef and stay on the list rather than opening a sentinel-less detail.
  async function openSkill(slug) {
    // Already inside a detail view with a live handle (e.g. a cross-link tap):
    // just swap content — one push/pop pair per detail level, no stacked sentinel.
    if (navRef.current) { showSkill(slug); return }
    const navOpen = window.mobius?.nav?.open
    if (typeof navOpen === 'function') {
      let handle
      try { handle = navOpen('skill-detail', () => { navRef.current = null; setSelected(null) }) } catch { handle = null }
      if (handle) {
        navRef.current = handle
        try {
          await handle.ready
        } catch {
          if (navRef.current === handle) navRef.current = null
          return // shell rejected the push; stay on the list
        }
        if (navRef.current !== handle) return // superseded by another open/close
        showSkill(slug)
        return
      }
    }
    showSkill(slug) // no nav available — open directly
  }

  function closeSkill() {
    try { navRef.current?.close?.() } catch {}
    navRef.current = null
    setSelected(null)
  }

  // If a refresh drops the currently-open skill, close the detail so we don't
  // leak the nav sentinel (a later device back would otherwise be consumed).
  useEffect(() => {
    if (selected && skills && !skills.some((s) => s.slug === selected)) closeSkill()
  }, [selected, skills])

  function askAgent(draft) {
    window.parent.postMessage({ type: 'moebius:new-chat', draft }, window.location.origin)
  }

  // Keep the app mounted when a link is tapped inside a rendered skill.
  function onDetailClick(e) {
    const a = e.target.closest && e.target.closest('a')
    if (!a) return
    const link = classifyLink(a.getAttribute('href'))
    if (link.kind === 'anchor') return // in-page fragment — harmless, leave default
    if (link.kind === 'skill') {
      e.preventDefault()
      if (skills && skills.some((s) => s.slug === link.slug)) {
        openSkill(link.slug)
      } else {
        window.mobius?.signal?.('error', { message: `unknown skill link ${link.slug}`, source: 'skill_link' })
      }
      return
    }
    if (link.kind === 'external') {
      e.preventDefault()
      window.open(link.url, '_blank', 'noopener,noreferrer')
      return
    }
    // Unsupported protocol or sub-path: block the navigation, keep the app up.
    e.preventDefault()
    window.mobius?.signal?.('error', { message: `blocked link (${link.reason})`, source: 'skill_link' })
  }

  const filtered = useMemo(() => {
    if (!skills) return []
    const q = query.trim().toLowerCase()
    if (!q) return skills
    return skills.filter((s) =>
      s.title.toLowerCase().includes(q) || s.slug.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
  }, [skills, query])

  const current = selected && skills ? skills.find((s) => s.slug === selected) : null
  const detailHtml = useMemo(() => {
    if (!current || current.unavailable) return ''
    try {
      return DOMPurify.sanitize(marked.parse(current.content || ''))
    } catch (err) {
      window.mobius?.signal?.('error', { message: String(err?.message || err), source: 'markdown_render' })
      return ''
    }
  }, [current])

  const syncPill = !online
    ? <div className="sk-sync-pill" role="status">Offline</div>
    : (loadError && skills)
      ? <div className="sk-sync-pill is-error" role="status">Couldn’t refresh</div>
      : null

  // ---- Detail view ----
  if (current) {
    return (
      <div className="sk-root">
        <style>{CSS}</style>
        {syncPill}
        <div className="sk-detail-head">
          <button className="sk-back" onClick={closeSkill} aria-label="Back to skills">{BACK}<span>Skills</span></button>
          <div className="sk-detail-title">{current.title}</div>
          <button className="sk-iconbtn" onClick={() => {
            window.mobius?.signal?.('edit_requested', { type: 'skill', slug: current.slug })
            askAgent(`Help me edit the "${current.slug}" skill. Here's what I want to change: `)
          }} aria-label="Edit skill with the agent">{PLUS}</button>
        </div>
        <div className="sk-scroll">
          {current.unavailable ? (
            <div className="sk-empty">
              <div className="sk-empty-mark" aria-hidden="true">⚠️</div>
              <div className="sk-empty-title">Couldn’t load this skill</div>
              <p className="sk-empty-text">The file for “{current.slug}” couldn’t be read. Try refreshing, or ask the agent to check it.</p>
            </div>
          ) : (
            <div className="sk-md" onClick={onDetailClick} dangerouslySetInnerHTML={{ __html: detailHtml }} />
          )}
        </div>
      </div>
    )
  }

  // ---- List view ----
  const loading = skills === null && !loadError
  const initialError = skills === null && loadError
  return (
    <div className="sk-root">
      <style>{CSS}</style>
      {syncPill}
      <header className="sk-header">
        <div className="sk-brand">
          <span className="sk-mark" aria-hidden="true">{HAMMER}</span>
          <div>
            <h1 className="sk-title">Skills</h1>
            <span className="sk-subtitle">{skills ? `${skills.length} agent ${skills.length === 1 ? 'skill' : 'skills'}` : 'Your agent’s abilities'}</span>
          </div>
        </div>
        <button className={`sk-iconbtn${refreshing ? ' is-spinning' : ''}`} onClick={refresh} disabled={refreshing} aria-label="Refresh skills">{REFRESH}</button>
      </header>

      <div className="sk-scroll">
        {skills !== null && skills.length > 0 && (
          <div className="sk-searchwrap">
            <div className="sk-search">
              {SEARCH}
              <input className="sk-input" type="search" value={query} placeholder="Search skills…"
                onChange={(e) => setQuery(e.target.value)} aria-label="Search skills" />
            </div>
          </div>
        )}

        {loading && (
          <div className="sk-empty"><div className="sk-spinner" /><div className="sk-empty-title">Loading skills…</div></div>
        )}

        {initialError && (
          <div className="sk-empty">
            <div className="sk-empty-mark" aria-hidden="true">⚠️</div>
            <div className="sk-empty-title">Couldn’t load skills</div>
            <p className="sk-empty-text">{loadError}</p>
            <button className="sk-retry" onClick={refresh}>Try again</button>
          </div>
        )}

        {skills !== null && skills.length === 0 && (
          <div className="sk-empty">
            <div className="sk-empty-mark" aria-hidden="true">{HAMMER}</div>
            <div className="sk-empty-title">No skills yet</div>
            <p className="sk-empty-text">Skills extend what your agent can do. Ask the agent to create one and it’ll appear here.</p>
            <button className="sk-retry" onClick={() => {
              window.mobius?.signal?.('item_created', { type: 'skill' })
              askAgent('Create a new skill for me. It should: ')
            }}>Ask the agent</button>
          </div>
        )}

        {skills !== null && skills.length > 0 && filtered.length === 0 && (
          <div className="sk-empty">
            <div className="sk-empty-mark" aria-hidden="true">{SEARCH}</div>
            <div className="sk-empty-title">No matches</div>
            <p className="sk-empty-text">No skills match “{query}”.</p>
          </div>
        )}

        {skills !== null && filtered.length > 0 && (
          <div className="sk-list">
            {filtered.map((s) => (
              <button key={s.slug} className="sk-row" onClick={() => openSkill(s.slug)}>
                <span className="sk-rowicon" aria-hidden="true">{HAMMER}</span>
                <span className="sk-rowbody">
                  <div className="sk-rowname">{s.title}</div>
                  <div className="sk-rowslug">{s.slug}</div>
                  {s.unavailable
                    ? <div className="sk-rowtag">Unavailable</div>
                    : (s.description && <div className="sk-rowdesc">{s.description}</div>)}
                </span>
                <span className="sk-chev" aria-hidden="true">{CHEV}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
