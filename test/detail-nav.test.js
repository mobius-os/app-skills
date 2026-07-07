import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDetailNav } from '../domain.js'

// The double-tap-during-pending-push race (found in adversarial review): a
// second row tap while the first shell push is still pending must NOT leave the
// app showing detail with no live back sentinel, even if the first push then
// rejects. These tests drive createDetailNav with a controllable handle.

function deferredHandle() {
  let resolve, reject
  const ready = new Promise((res, rej) => { resolve = res; reject = rej })
  return { handle: { ready, close: () => {} }, resolve, reject }
}

test('double tap during a pending push, then reject: never left in detail', async () => {
  const shown = []
  let closes = 0
  const d = deferredHandle()
  const nav = createDetailNav({
    label: 'skill-detail',
    getNavOpen: () => () => d.handle,   // one push in flight, ready still pending
    onShow: (slug) => shown.push(slug),
    onClose: () => { closes += 1 },
  })
  const p1 = nav.open('one')            // installs handle, awaits ready
  const p2 = nav.open('two')            // pending push → retarget only, no render
  assert.deepEqual(shown, [], 'no detail rendered while the push is unconfirmed')
  d.reject(new Error('shell rejected'))
  await Promise.allSettled([p1, p2])
  assert.deepEqual(shown, [], 'rejected push must not render sentinel-less detail')
  assert.equal(nav.isOpen(), false, 'no dangling handle after rejection')
})

test('double tap during a pending push, then resolve: renders the LATEST slug once', async () => {
  const shown = []
  const d = deferredHandle()
  const nav = createDetailNav({
    label: 'skill-detail',
    getNavOpen: () => () => d.handle,
    onShow: (slug) => shown.push(slug),
    onClose: () => {},
  })
  const p1 = nav.open('one')
  const p2 = nav.open('two')            // retargets the in-flight open
  d.resolve()
  await Promise.allSettled([p1, p2])
  assert.deepEqual(shown, ['two'], 'renders the latest requested slug exactly once')
  assert.equal(nav.isOpen(), true)
})

test('cross-link tap while detail is READY swaps content directly', async () => {
  const shown = []
  const d = deferredHandle()
  let opens = 0
  const nav = createDetailNav({
    label: 'skill-detail',
    getNavOpen: () => () => { opens += 1; return d.handle },
    onShow: (slug) => shown.push(slug),
    onClose: () => {},
  })
  const p1 = nav.open('one')
  d.resolve()
  await p1
  await nav.open('two')                 // already open+ready → swap, no new handle
  assert.deepEqual(shown, ['one', 'two'])
  assert.equal(opens, 1, 'no second sentinel installed for a cross-link swap')
})

test('no shell nav available: opens directly', async () => {
  const shown = []
  const nav = createDetailNav({
    label: 'skill-detail',
    getNavOpen: () => undefined,
    onShow: (slug) => shown.push(slug),
    onClose: () => {},
  })
  await nav.open('one')
  assert.deepEqual(shown, ['one'])
  assert.equal(nav.isOpen(), false)
})
