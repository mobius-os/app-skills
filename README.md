# app-skills — Skills

A [Möbius](https://github.com/mobius-os) catalog mini-app. v1 was a read-only
skill browser; v2 keeps that reading experience and adds the write half of the
skills story. The write features require a platform with the skills API
(`mobius-os/mobius` PR #146 or later); older platforms automatically retain
read-only browsing through shared storage instead of failing the whole app.

**Browse & read** — the list comes from `GET /api/skills`, so it shows every
skill shape (flat `<name>.md` and directory `<name>/SKILL.md`) with provenance
(built-in seed / agent-authored / app-owned / installed-from) and 30-day usage
counts. Tap a skill to read it as sanitized markdown (full markdown fetched
lazily from shared storage).

**Owner-chosen chat** — the app does not open or prefill another chat. To find,
create, or edit a custom skill with the agent, the owner starts that request in
whichever chat they choose.

**Catalog screen** — the ▤ header button opens a curated list of public repos
that host SKILL.md skills. One recursive git-trees call per source (through
`/api/proxy`) finds every skill — flat cards, no folder dead ends; summaries
prefetch in the background (raw-file fetches, no API rate cost). Cards install
via `POST /api/skills/install` (gated by this app's `manage_skills`
permission). Sources are app data (`sources.json`) — ask the agent to add a
repo.

**Uninstall** — install-provenance skills get a two-tap remove button in the
detail view (`DELETE /api/skills/<name>`; the server git-snapshots the bytes
first). Seeds, agent files, and app-owned skills keep their own lifecycles —
editing routes to the agent, as in v1.

## File layout

| File | Role |
|------|------|
| `index.jsx` | Default-export React component: list, detail, catalog screen, all UI/state. |
| `domain.js` | Dependency-free core: parsing, link classification, nav state machine, provenance/usage formatting, content-path selection. |
| `catalog.js` | Dependency-free catalog core: source list, tree-scan filtering, summary parsing, prefetch pool. Network is injected. |
| `test/` | Regression tests for both cores (`npm test` → `node --test`). |
| `mobius.json` | App manifest (id, permissions incl. `manage_skills`, runtime deps). |

## Dev loop

In a dev instance, register once from a chat/shell:

```bash
cp -r app-skills /data/apps/skills
python "$SCRIPTS_DIR/register_app.py" skills \
  "Browse and install agent skills" /data/apps/skills/index.jsx
```

Then edit files in place; the watcher recompiles on save. Note that
`register_app.py` does not apply manifest permissions — grant `manage_skills`
through the platform when testing installs.
