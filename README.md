# app-skills — Skills

A [Möbius](https://github.com/mobius-os) catalog mini-app. Install it from the
in-app App Store.

Skills is a **read-only catalog** for the agent's skill files — the SKILL-style
markdown guides under `/data/shared/skills/` that shape what the Möbius agent
can do. It enumerates the shared skills folder, parses each file's title and
one-line description, searches locally, and renders the selected skill as
sanitized markdown. Creating and editing a skill is routed to the agent (see
below), never written from the app.
Installed system apps that add an always-on instruction block are listed below the editable skills so their effect on every chat is visible.

## File layout

| File | Role |
|------|------|
| `index.jsx` | Default-export React component: the list, search, detail view, and all UI/state. |
| `domain.js` | Pure, dependency-free core — `parseSkill`, `classifyLink`, `friendlyLoadError`. No React, no I/O, so it's unit-testable. |
| `test/domain.test.js` | Regression tests for `domain.js` (run with `npm test` → `node --test`). |
| `mobius.json` | App manifest (id, permissions, runtime deps, offline contract). |
| `icon.png` | App icon. |

## Skill markdown shape

Skill files may be plain markdown or include a small YAML frontmatter block.
`parseSkill()` strips frontmatter from the rendered detail and reads:

- **Title** — the first `# Heading` outside any fenced code block. If a file has
  no `#` heading, the title falls back to `name` from frontmatter, then to a
  Title-Cased version of the slug (filename without `.md`).
- **Description** — the first non-empty paragraph after the title, up to ~240
  chars, stopping at the next heading, `---`, or a fenced code block. If the
  body has no paragraph, `description` from frontmatter is used as a fallback.

Fenced code blocks (``` ``` ``` or `~~~`) are tracked so a `# comment` or a
fence marker *inside* a code block is never mistaken for the title or the
description.

## Data contract (shared storage, read-only)

The app reads shared storage with its scoped app token — it can **read** shared
files but cannot **write** them, so all mutations route through the agent:

- `GET /api/storage/shared-list/skills/` — enumerate the skills folder
  (immediate children). The app keeps only `type: "file"`, `*.md`, non-dotfile
  entries. It never probes guessed paths.
- `GET /api/storage/shared/skills/<name>` — fetch one skill's markdown.

A per-file fetch that fails (non-OK or thrown) keeps the row but marks it
**Unavailable** rather than rendering a blank skill, and emits an `error` signal
(`source: "skill_load"`) so a corrupt or permission-broken file isn't mistaken
for intentionally empty content.

A failed **Refresh** keeps the last-known-good list on screen (it does not wipe
it) and surfaces a small "Couldn't refresh" pill; retry from the header refresh
button. The full error screen is reserved for the very first load.

### Create / edit routes to the agent

Skills are shared, owner-authored context. Because a mini-app can't write shared
storage, the **Edit** button (detail view) and the empty-state **Ask the agent**
button post a `moebius:new-chat` message to the shell with a pre-filled draft,
opening an agent chat rather than saving in-app.

## Link behavior in a rendered skill

The whole app lives in one iframe, so an unhandled link click would navigate the
iframe away and brick the view. `classifyLink()` + a delegated click handler on
the rendered markdown route every link safely:

- **Same-folder `.md` link** (e.g. `[shapes](app-component-shapes.md)` or
  `./name.md`) → opened in-app via the detail view, no iframe navigation. If the
  target isn't in the loaded set, the tap is swallowed (app stays up) and an
  `error` signal fires.
- **`http:` / `https:` link** → opened in a new browser context via
  `window.open(url, '_blank', 'noopener,noreferrer')`.
- **In-page `#fragment`** → left to default (harmless, doesn't replace the doc).
- **Any other protocol or sub-path** → navigation is blocked and an `error`
  signal fires; the app stays mounted.

## Signals (for Reflection)

Emitted via `window.mobius.signal(...)`, all flat primitives:

- `app_ready { item_count }` — once, after the first successful load (gated so
  manual refreshes don't inflate open counts).
- `item_opened { type: "skill", slug }` — a skill detail was opened.
- `edit_requested { type: "skill", slug }` — the owner tapped Edit on a skill.
- `item_created { type: "skill" }` — the empty-state create CTA was launched (a
  request to create; it does not claim a file now exists).
- `error { message, source, status? }` — `source` is `skill_load` (per-file
  fetch), `markdown_render` (parse/sanitize), `skill_link` (blocked/unknown
  link), or `load`/`refresh` (list load).

## Offline

This is an online-only viewer (`offline_capable: false`): it reads live shared
storage and has nothing useful to cache for a cold offline open. The manifest's
top-level `offline` object —
`{ "reads": false, "writes": "none", "execution": "none" }` — is the honest
offline contract. The installer reads it and stores it as the app's
`offline_contract` (exposed via the apps API), so it is kept deliberately, not
dead metadata. When offline, the app shows a plain "Offline" pill; the list
stays visible if it was already loaded.

## Rendering safety

Markdown is rendered with `DOMPurify.sanitize(marked.parse(...))` — never raw
`marked` output. `marked` and `dompurify` are declared as `esm_deps` in
`mobius.json`.

## Development

```bash
npm test        # node --test over test/*.test.js — no install needed (Node 18+)
```

The tests cover `domain.js` only (the pure core); the React UI has no runtime
dependencies to mock. To compile-smoke the entry:

```bash
esbuild index.jsx --bundle --packages=external --format=esm --loader:.js=jsx --outfile=/dev/null
```
