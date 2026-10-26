// The page turns `state`, as when the user switches to another tab or back:
// document.visibilityState changes and visibilitychange fires.
// restoreVisibility() brings the real value back.
export function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

export function restoreVisibility(): void {
  Reflect.deleteProperty(document, 'visibilityState')
}

// The page counts as visible, whatever the test runner's window does, until
// restoreVisibility(): polling pauses in a hidden page, and a runner's window
// is hidden while it's minimized or behind another tab. Fires no
// visibilitychange: a spec mustn't see the user coming back.
export function pinVisible(): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  })
}

// The user leaves the page and comes back to it, as when they switch to
// another tab and back. The real visibilityState comes back afterwards.
export function leaveAndComeBack(): void {
  setVisibility('hidden')
  setVisibility('visible')
  restoreVisibility()
}

// The network goes away and comes back, as the browser reports it.
export function goOfflineAndBack(): void {
  window.dispatchEvent(new Event('offline'))
  window.dispatchEvent(new Event('online'))
}
