import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

// Render-level regression tests for the catalog card's Install control, through
// the same esbuild + react-dom/server harness as a11y.test.js. The install
// button's enabled/label state is derived, so assert it on the real markup a
// keyboard/SR user gets. Skips cleanly when the shell's frontend deps are
// unavailable (CI sets MOBIUS_FRONTEND_NODE_MODULES; a sibling mobius checkout
// also works).

function frontendNodeModules() {
  const fromEnv = process.env.MOBIUS_FRONTEND_NODE_MODULES
  if (fromEnv && existsSync(join(fromEnv, 'react'))) return fromEnv
  const here = fileURLToPath(new URL('.', import.meta.url))
  for (const rel of ['../.mobius/frontend/node_modules', '../../mobius/frontend/node_modules']) {
    const candidate = join(here, '..', rel)
    if (existsSync(join(candidate, 'react'))) return candidate
  }
  return null
}

const nm = frontendNodeModules()

// The Install control is the first non-ghost `sk-btn` in the card's button row.
function installButton(html) {
  const m = html.match(/<button class="sk-btn"[^>]*>[\s\S]*?<\/button>/)
  assert.ok(m, 'expected an Install button')
  return m[0]
}
const isDisabled = (btn) => /\bdisabled\b/.test(btn)

test(
  'catalog card: Install is disabled-and-unsupported / prop-driven installed state',
  { skip: nm ? false : 'frontend deps unavailable (set MOBIUS_FRONTEND_NODE_MODULES)' },
  async () => {
    const require2 = createRequire(join(nm, 'noop.js'))
    const esbuild = require2('esbuild')
    const workDir = mkdtempSync(join(tmpdir(), 'skills-card-'))
    try {
      writeFileSync(join(workDir, 'marked-stub.mjs'), 'export const marked = { parse: () => "" }\n')
      writeFileSync(join(workDir, 'dompurify-stub.mjs'), 'export default { sanitize: (x) => x }\n')
      const built = await esbuild.build({
        entryPoints: [fileURLToPath(new URL('../index.jsx', import.meta.url))],
        bundle: true, write: false, format: 'esm',
        loader: { '.jsx': 'jsx' }, jsx: 'automatic',
        external: ['react', 'react-dom', 'react/jsx-runtime'],
        alias: {
          marked: join(workDir, 'marked-stub.mjs'),
          dompurify: join(workDir, 'dompurify-stub.mjs'),
        },
      })
      symlinkSync(nm, join(workDir, 'node_modules'))
      const bundlePath = join(workDir, 'app.mjs')
      writeFileSync(bundlePath, built.outputFiles[0].text)
      const { CatalogCard } = await import(pathToFileURL(bundlePath))
      const React = require2('react')
      const { renderToStaticMarkup } = require2('react-dom/server')

      const base = {
        skill: { name: 'pdf', dir: 'skills/pdf', id: 'pdf' },
        desc: { description: 'Fill PDFs.', raw: 'body' },
        busy: false, anyBusy: false,
        onOpen: () => {}, onLoad: () => {}, onInstall: () => {},
        onCaveats: () => {}, onRetry: () => {},
      }
      const render = (props) => renderToStaticMarkup(
        React.createElement(CatalogCard, { ...base, ...props }),
      )

      // B1: a blocking compat caveat (SKILL.md over the fetch cap) → Install is
      // disabled and labelled Unsupported, never an amber-but-runnable action.
      const tooBig = render({
        installed: false,
        compat: { ok: false, caveats: [{ kind: 'skill-too-large', text: 'too big' }] },
      })
      const tooBigBtn = installButton(tooBig)
      assert.ok(isDisabled(tooBigBtn), 'over-cap Install must be disabled')
      assert.match(tooBigBtn, /Unsupported/)

      // B1: a soft caveat (scripts) stays installable.
      const scripts = render({
        installed: false,
        compat: { ok: false, caveats: [{ kind: 'scripts', text: 'has scripts' }] },
      })
      assert.ok(!isDisabled(installButton(scripts)), 'soft-caveat Install stays enabled')

      // B2: installed-ness is purely a function of the `installed` prop (the
      // single root set) — no internal latch. false → Install + enabled;
      // true → Installed + disabled; and back to false → Install + enabled,
      // proving a card can go from installed to not-installed when the
      // authoritative set shrinks.
      const clean = { ok: true, caveats: [] }
      const notInstalled = installButton(render({ installed: false, compat: clean }))
      assert.match(notInstalled, /Install<\/button>|>Install</)
      assert.ok(!isDisabled(notInstalled))

      const installed = installButton(render({ installed: true, compat: clean }))
      assert.match(installed, /Installed/)
      assert.ok(isDisabled(installed))

      const backToNotInstalled = installButton(render({ installed: false, compat: clean }))
      assert.match(backToNotInstalled, />Install</)
      assert.ok(!isDisabled(backToNotInstalled), 'card follows the prop back to not-installed')
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  },
)
