import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDetailNav } from '../domain.js'

// createDetailNav drives the shell back-sentinel. Two things it must get right:
//  1. the double-tap-during-pending-push race (a second tap while the first push
//     is unconfirmed must not render sentinel-less detail or stack a handle);
//  2. the REAL nav contract — handle.ready RESOLVES true (owned) or false
//     (push refused / timed out), it never REJECTS (locked by mobius-runtime's
//     own tests: nav-push-ack → ready===true, nav-push-rejected → ready===false).
// These deferred handles model that contract: resolve(true) / resolve(false),
// never reject.

function deferredHandle() {
  let resolve
  const ready = new Promise((res) => { resolve = res })
  return { handle: { ready, close: () => {} }, resolve }
}

test('double tap during a pending push, then push REFUSED (ready→false): shows content, owns no sentinel', async () => {
  const shown = []
  const d = deferredHandle()
  const nav = createDetailNav({
    label: 'skill-detail',
    getNavOpen: () => () => d.handle,   // one push in flight, ready still pending
    onShow: (slug) => shown.push(slug),
    onClose: () => {},
  })
  const p1 = nav.open('one')            // installs handle, awaits ready
  const p2 = nav.open('two')            // pending push → retarget only, no render yet
  assert.deepEqual(shown, [], 'no detail rendered while the push is unconfirmed')
  d.resolve(false)                      // shell refuses the back target
  await Promise.allSettled([p1, p2])
  // On refusal we STILL show the latest content (blocking would be worse UX)...
  assert.deepEqual(shown, ['two'], 'refused push still shows the latest requested slug')
  // ...but we must NOT claim to own a sentinel the shell never installed.
  assert.equal(nav.isOpen(), false, 'no phantom sentinel after a refused push')
})

test('double tap during a pending push, then ACK (ready→true): renders the LATEST slug once and owns the sentinel', async () => {
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
  d.resolve(true)
  await Promise.allSettled([p1, p2])
  assert.deepEqual(shown, ['two'], 'renders the latest requested slug exactly once')
  assert.equal(nav.isOpen(), true)
})

test('a runtime that THROWS from ready is treated as not-owned (defensive)', async () => {
  const shown = []
  const ready = Promise.reject(new Error('broken runtime'))
  ready.catch(() => {})                 // avoid an unhandled-rejection warning
  const nav = createDetailNav({
    label: 'skill-detail',
    getNavOpen: () => () => ({ ready, close: () => {} }),
    onShow: (slug) => shown.push(slug),
    onClose: () => {},
  })
  await nav.open('one')
  assert.deepEqual(shown, ['one'], 'still shows content on a broken runtime')
  assert.equal(nav.isOpen(), false, 'owns no sentinel when ready throws')
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
  d.resolve(true)
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
