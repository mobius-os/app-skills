import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

// Accessibility render test: the catalog card's open action must be a REAL,
// focusable control — not a click-only div (WCAG 2.1.1). Renders the actual
// CatalogCard through esbuild + react-dom/server, so the assertion is on the
// markup keyboard/SR users actually get.
//
// Needs the shell's frontend deps (react, react-dom, esbuild). CI provides
// them via MOBIUS_FRONTEND_NODE_MODULES; locally a sibling mobius checkout
// works too. Skips cleanly when neither is available — the pure suites don't
// pay this cost.

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

test(
  'a11y: the catalog card opens through a real, focusable button',
  { skip: nm ? false : 'frontend deps unavailable (set MOBIUS_FRONTEND_NODE_MODULES)' },
  async () => {
    const require2 = createRequire(join(nm, 'noop.js'))
    const esbuild = require2('esbuild')

    const workDir = mkdtempSync(join(tmpdir(), 'skills-a11y-'))
    try {
      // marked/dompurify are runtime esm_deps of the shell, not render deps of
      // this test — stub them so only react does real work.
      const stubs = join(workDir, 'stubs')
      writeFileSync(join(workDir, 'marked-stub.mjs'), 'export const marked = { parse: () => "" }\n')
      writeFileSync(
        join(workDir, 'dompurify-stub.mjs'),
        'export default { sanitize: (x) => x }\n',
      )

      const built = await esbuild.build({
        entryPoints: [fileURLToPath(new URL('../index.jsx', import.meta.url))],
        bundle: true,
        write: false,
        format: 'esm',
        loader: { '.jsx': 'jsx' },
        jsx: 'automatic', // index.jsx never imports React itself
        external: ['react', 'react-dom', 'react/jsx-runtime'],
        alias: {
          marked: join(workDir, 'marked-stub.mjs'),
          dompurify: join(workDir, 'dompurify-stub.mjs'),
        },
      })
      // Import the bundle from a dir whose node_modules is the frontend's, so
      // the react externals resolve to the exact packages the shell serves.
      symlinkSync(nm, join(workDir, 'node_modules'))
      const bundlePath = join(workDir, 'app.mjs')
      writeFileSync(bundlePath, built.outputFiles[0].text)
      const { CatalogCard } = await import(pathToFileURL(bundlePath))
      assert.ok(CatalogCard, 'CatalogCard must stay exported for this test')

      const React = require2('react')
      const { renderToStaticMarkup } = require2('react-dom/server')
      const html = renderToStaticMarkup(React.createElement(CatalogCard, {
        skill: { name: 'pdf', dir: 'skills/pdf', id: 'pdf' },
        desc: { description: 'Fill PDFs.', raw: '' },
        installed: false,
        busy: false,
        compat: { ok: true, caveats: [] },
        onOpen: () => {}, onLoad: () => {}, onInstall: () => {},
        onCaveats: () => {}, onRetry: () => {},
      }))

      // The open action is a semantic button whose accessible name is the
      // skill's own title + summary (name comes from content).
      const open = html.match(/<button[^>]*class="sk-cardopen"[^>]*>([\s\S]*?)<\/button>/)
      assert.ok(open, 'expected a <button class="sk-cardopen"> open control')
      assert.match(open[0], /type="button"/)
      assert.ok(open[1].includes('pdf'), 'the button carries the skill name')
      assert.ok(open[1].includes('Fill PDFs.'), 'and the summary')
      // No nested interactive controls inside the open button (invalid HTML,
      // broken SR semantics) — Install and friends live OUTSIDE it.
      assert.ok(!/<(button|a)[\s>]/.test(open[1]), 'no controls nested in the open button')
      assert.match(html, /Install/)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  },
)
