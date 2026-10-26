import {
  EnvironmentInjector,
  PLATFORM_ID,
  type Provider,
  createEnvironmentInjector,
  runInInjectionContext,
} from '@angular/core'
import { TestBed } from '@angular/core/testing'

import {
  restoreVisibility,
  setVisibility,
} from '../../spec-helpers/page-events'
import { onReconnect, onWindowFocus, pageVisibility } from './browser-events'

// The injectors startIn() created and nothing has destroyed yet. Destroying
// TestBed's injector doesn't destroy them, so stopAll() does it after each
// spec: a listener left on the real document would outlive the spec.
const running = new Set<EnvironmentInjector>()

// Runs `start` in an injector of its own, with these providers, the way a
// client starts listening in its constructor. Returns a function that
// destroys the injector, which ends what `start` started.
function startIn(start: () => void, providers: Provider[] = []): () => void {
  const injector = createEnvironmentInjector(
    providers,
    TestBed.inject(EnvironmentInjector),
  )

  running.add(injector)
  runInInjectionContext(injector, start)

  return () => {
    running.delete(injector)
    injector.destroy()
  }
}

function stopAll(): void {
  running.forEach((injector) => injector.destroy())
  running.clear()
}

const onTheServer = { provide: PLATFORM_ID, useValue: 'server' }

describe('pageVisibility', () => {
  afterEach(restoreVisibility)

  it('tells whether the page is visible at the moment it is asked', () => {
    const visible = TestBed.runInInjectionContext(pageVisibility)

    setVisibility('hidden')
    expect(visible()).toBe(false)

    setVisibility('visible')
    expect(visible()).toBe(true)
  })

  it('counts a page that is neither visible nor hidden as visible', () => {
    const visible = TestBed.runInInjectionContext(pageVisibility)

    // jsdom, which many test setups run in, says 'prerender' unless it's
    // told to pretend to be visual.
    setVisibility('prerender' as DocumentVisibilityState)

    expect(visible()).toBe(true)
  })
})

describe('onWindowFocus', () => {
  afterEach(() => {
    stopAll()
    restoreVisibility()
  })

  it('calls the listener when the page turns visible, not when it turns hidden', () => {
    const listener = jasmine.createSpy('listener')

    startIn(() => onWindowFocus(listener))

    setVisibility('hidden')
    expect(listener).not.toHaveBeenCalled()

    setVisibility('visible')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("doesn't call it on the window's focus event", () => {
    const listener = jasmine.createSpy('listener')

    startIn(() => onWindowFocus(listener))

    window.dispatchEvent(new Event('focus'))

    expect(listener).not.toHaveBeenCalled()
  })

  it('stops once its injector is destroyed', () => {
    const listener = jasmine.createSpy('listener')
    const stop = startIn(() => onWindowFocus(listener))

    stop()
    setVisibility('hidden')
    setVisibility('visible')

    expect(listener).not.toHaveBeenCalled()
  })

  it("doesn't listen on the server", () => {
    const listener = jasmine.createSpy('listener')

    startIn(() => onWindowFocus(listener), [onTheServer])

    setVisibility('hidden')
    setVisibility('visible')

    expect(listener).not.toHaveBeenCalled()
  })
})

describe('onReconnect', () => {
  afterEach(stopAll)

  it('calls the listener when the network comes back, not when it goes away', () => {
    const listener = jasmine.createSpy('listener')

    startIn(() => onReconnect(listener))

    window.dispatchEvent(new Event('offline'))
    expect(listener).not.toHaveBeenCalled()

    window.dispatchEvent(new Event('online'))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stops once its injector is destroyed', () => {
    const listener = jasmine.createSpy('listener')
    const stop = startIn(() => onReconnect(listener))

    stop()
    window.dispatchEvent(new Event('online'))

    expect(listener).not.toHaveBeenCalled()
  })

  it("doesn't listen on the server", () => {
    const listener = jasmine.createSpy('listener')

    startIn(() => onReconnect(listener), [onTheServer])

    window.dispatchEvent(new Event('online'))

    expect(listener).not.toHaveBeenCalled()
  })
})
