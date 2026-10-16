import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing'
import { type Observable, of, Subject, throwError } from 'rxjs'

import { settled } from '../../spec-helpers/promises'
import { CancelledError } from './cancelled-error'
import { Query, type QuerySubscriber } from './query'
import type { QueryCache } from './query-cache'

function createQuery<TData, TError = Error>() {
  // Query only calls cache.remove(this) on gc; a stub is enough.
  const cache = { remove: jasmine.createSpy('remove') }
  const query = new Query<TData, TError>(
    ['key'],
    '["key"]',
    cache as unknown as QueryCache,
  )

  return { query, cache }
}

// An observer that never wants the query fetched, for specs that only count
// observers.
function stubObserver(): QuerySubscriber<number> {
  return { fetchOptions: () => null, structuralSharing: () => true }
}

// How an observer that wants the query fetched would fetch it.
type ObserverOptions = NonNullable<
  ReturnType<QuerySubscriber<number>['fetchOptions']>
>

// An observer that wants the query fetched with `queryFn`, and refetched on
// window focus and reconnect while its data is stale, unless `options` say
// otherwise.
function activeObserver(
  queryFn: () => Observable<number>,
  options: Partial<ObserverOptions> = {},
): QuerySubscriber<number> {
  return {
    fetchOptions: () => ({
      queryFn,
      retry: 0,
      retryDelay: 0,
      structuralSharing: true,
      staleTime: 0,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      ...options,
    }),
    structuralSharing: () => true,
  }
}

describe('Query', () => {
  it('starts in a pending state with no data', () => {
    const { query } = createQuery<number>()
    const state = query.state()

    expect(state.status).toBe('pending')
    expect(state.data).toBeUndefined()
    expect(state.isFetching).toBe(false)
  })

  it('resolves an Observable queryFn to success', () => {
    const { query } = createQuery<number>()

    query.fetch({ queryFn: () => of(42) })

    const state = query.state()

    expect(state.status).toBe('success')
    expect(state.data).toBe(42)
    expect(state.isFetching).toBe(false)
  })

  it('allows a new fetch once the previous one has completed', () => {
    const { query } = createQuery<number>()

    query.fetch({ queryFn: () => of(1) })
    query.fetch({ queryFn: () => of(2) })

    expect(query.state().data).toBe(2)
  })

  it('cancel() aborts an in-flight fetch without resolving it', fakeAsync(() => {
    const { query } = createQuery<number>()

    query.fetch({ queryFn: () => Promise.resolve(1) })
    query.cancel()
    tick()

    expect(query.state().status).toBe('pending')
    expect(query.state().data).toBeUndefined()
    // isFetching must not stay stuck true after cancel.
    expect(query.state().isFetching).toBe(false)
  }))

  it('resolves a Promise queryFn to success', fakeAsync(() => {
    const { query } = createQuery<number>()

    query.fetch({ queryFn: () => Promise.resolve(7) })
    tick()

    expect(query.state().status).toBe('success')
    expect(query.state().data).toBe(7)
  }))

  it('sets isFetching while a Promise is in flight', fakeAsync(() => {
    const { query } = createQuery<number>()

    query.fetch({ queryFn: () => Promise.resolve(1) })
    expect(query.state().isFetching).toBe(true)

    tick()
    expect(query.state().isFetching).toBe(false)
  }))

  it('ignores a concurrent fetch while one is in flight', fakeAsync(() => {
    const { query } = createQuery<number>()
    const first = jasmine.createSpy('first').and.returnValue(Promise.resolve(1))
    const second = jasmine.createSpy('second')

    query.fetch({ queryFn: first })
    query.fetch({ queryFn: second })
    tick()

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  }))

  it('transitions to error when the queryFn fails', () => {
    const { query } = createQuery<number>()
    const err = new Error('boom')

    query.fetch({ queryFn: () => throwError(() => err) })

    const state = query.state()

    expect(state.status).toBe('error')
    expect(state.error).toBe(err)
    expect(state.isFetching).toBe(false)
  })

  it('errors when the queryFn completes without emitting', () => {
    const { query } = createQuery<number>()

    query.fetch({ queryFn: () => of<number>() })

    expect(query.state().status).toBe('error')
    expect(query.state().error?.message).toContain('without emitting')
  })

  it('retries the configured number of times then succeeds', fakeAsync(() => {
    const { query } = createQuery<number>()
    let attempts = 0
    const queryFn = () => {
      attempts++

      return attempts < 3 ? throwError(() => new Error('fail')) : of(99)
    }

    query.fetch({ queryFn, retry: 3, retryDelay: () => 10 })
    tick(100)

    expect(attempts).toBe(3)
    expect(query.state().status).toBe('success')
    expect(query.state().data).toBe(99)
  }))

  it('tracks failureCount and failureReason across retries', fakeAsync(() => {
    const { query } = createQuery<number>()
    const err = new Error('nope')

    // retry: 2 -> 3 attempts total before giving up.
    query.fetch({
      queryFn: () => throwError(() => err),
      retry: 2,
      retryDelay: () => 10,
    })
    tick(100)

    const state = query.state()

    expect(state.status).toBe('error')
    expect(state.error).toBe(err)
    expect(state.failureCount).toBe(3)
    expect(state.failureReason).toBe(err)
  }))

  describe('cancelRefetch', () => {
    it('dedupes a concurrent fetch by default (cancelRefetch = false)', fakeAsync(() => {
      const { query } = createQuery<number>()
      const first = jasmine
        .createSpy('first')
        .and.returnValue(new Promise<number>(() => {})) // never resolves
      const second = jasmine.createSpy('second')

      query.fetch({ queryFn: first })
      query.fetch({ queryFn: second }) // no cancelRefetch → ignored

      expect(first).toHaveBeenCalledTimes(1)
      expect(second).not.toHaveBeenCalled()
    }))

    it('cancels the in-flight fetch and starts a fresh one when cancelRefetch = true', fakeAsync(() => {
      const { query } = createQuery<number>()
      const first = jasmine
        .createSpy('first')
        .and.returnValue(new Promise<number>(() => {})) // never resolves
      const second = jasmine
        .createSpy('second')
        .and.returnValue(Promise.resolve(2))

      query.fetch({ queryFn: first })
      query.fetch({ queryFn: second }, { cancelRefetch: true }) // force: cancel first, run second
      tick()

      expect(first).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledTimes(1)
      expect(query.state().data).toBe(2)
    }))

    it('a late result from a cancelled fetch does not overwrite the new one', fakeAsync(() => {
      const { query } = createQuery<number>()
      let resolveFirst!: (value: number) => void
      const first = () =>
        new Promise<number>((resolve) => {
          resolveFirst = resolve
        })
      const second = () => Promise.resolve(2)

      query.fetch({ queryFn: first })
      query.fetch({ queryFn: second }, { cancelRefetch: true }) // cancel first, start second
      tick()
      expect(query.state().data).toBe(2)

      // The cancelled first fetch resolves late — it must not win.
      resolveFirst(1)
      tick()
      expect(query.state().data).toBe(2)
    }))
  })

  // fetch() returns a promise of the data as the query stores it, shared by
  // every caller of one fetch.
  describe('fetch promise', () => {
    it('resolves with the data as the query stores it', fakeAsync(() => {
      const { query } = createQuery<{ id: number }>()

      query.setData({ id: 1 })

      const stored = query.state().data
      const result = settled(
        query.fetch({ queryFn: () => of({ id: 1 }), structuralSharing: true }),
      )

      flushMicrotasks()

      // Structural sharing kept the stored object, so that's what it resolves
      // with, not the equal one queryFn emitted.
      expect(result.value).toBe(stored)
    }))

    it('gives a caller that joins the fetch in flight the same promise', () => {
      const { query } = createQuery<number>()
      const first = query.fetch({ queryFn: () => new Subject<number>() })

      expect(query.fetch({ queryFn: () => of(2) })).toBe(first)
    })

    it('gives the next fetch a new promise once one has settled', () => {
      const { query } = createQuery<number>()
      const first = query.fetch({ queryFn: () => of(1) })

      expect(query.fetch({ queryFn: () => of(2) })).not.toBe(first)
    })

    it('rejects with the error once the retries are spent', fakeAsync(() => {
      const { query } = createQuery<number>()
      const error = new Error('down')
      const result = settled(
        query.fetch({
          queryFn: () => throwError(() => error),
          retry: 1,
          retryDelay: 10,
        }),
      )

      tick(9)
      expect(result).toEqual({})

      tick(1)
      expect(result.error).toBe(error)
    }))

    it('settles with the fetch that replaces it, however often it is replaced', fakeAsync(() => {
      const { query } = createQuery<number>()
      const responses = [0, 1, 2].map(() => new Subject<number>())
      let sent = 0
      const queryFn = () => responses[sent++]
      const first = settled(query.fetch({ queryFn }))
      const second = settled(query.fetch({ queryFn }, { cancelRefetch: true }))
      const third = settled(query.fetch({ queryFn }, { cancelRefetch: true }))

      // A replaced request that answers anyway changes nothing.
      responses[0].next(1)
      flushMicrotasks()
      expect(first).toEqual({})

      responses[2].next(3)
      flushMicrotasks()
      expect([first.value, second.value, third.value]).toEqual([3, 3, 3])
    }))

    it('rejects with the error of the fetch that replaces it', fakeAsync(() => {
      const { query } = createQuery<number>()
      const error = new Error('down')
      const replaced = settled(
        query.fetch({ queryFn: () => new Subject<number>() }),
      )

      query.fetch(
        { queryFn: () => throwError(() => error) },
        { cancelRefetch: true },
      )
      flushMicrotasks()

      expect(replaced.error).toBe(error)
    }))

    it('resolves with the data the query holds when the fetch is cancelled', fakeAsync(() => {
      const { query } = createQuery<number>()

      query.setData(1)

      const result = settled(
        query.fetch({ queryFn: () => new Subject<number>() }),
      )

      query.cancel()
      flushMicrotasks()

      expect(result.value).toBe(1)
    }))

    it('rejects with a CancelledError when the fetch is cancelled before there is data', fakeAsync(() => {
      const { query } = createQuery<number>()
      const result = settled(
        query.fetch({ queryFn: () => new Subject<number>() }),
      )

      query.cancel()
      flushMicrotasks()

      expect(result.error).toBeInstanceOf(CancelledError)
    }))

    it('rejects with a CancelledError when the query is destroyed, even with data', fakeAsync(() => {
      const { query } = createQuery<number>()

      query.setData(1)

      const result = settled(
        query.fetch({ queryFn: () => new Subject<number>() }),
      )

      query.destroy()
      flushMicrotasks()

      expect(result.error).toBeInstanceOf(CancelledError)
    }))

    it("doesn't surface a failure nobody waits for as an unhandled rejection", fakeAsync(() => {
      const { query } = createQuery<number>()

      query.fetch({ queryFn: () => throwError(() => new Error('down')) })
      query.fetch({ queryFn: () => new Subject<number>() })
      query.cancel()

      // fakeAsync rethrows an unhandled rejection when microtasks run.
      expect(() => flushMicrotasks()).not.toThrow()
      expect(query.state().status).toBe('error')
    }))
  })

  describe('setData', () => {
    it('writes data and marks the query successful', () => {
      const { query } = createQuery<number>()

      query.setData(5)

      expect(query.state().data).toBe(5)
      expect(query.state().status).toBe('success')
      expect(query.state().updatedAt).toBeGreaterThan(0)
    })
  })

  describe('setData with explicit updatedAt (initialData)', () => {
    it('seeds success state with the given updatedAt', () => {
      const { query } = createQuery<number>()

      query.setData(1, { updatedAt: 0 })

      expect(query.state().status).toBe('success')
      expect(query.state().data).toBe(1)
      expect(query.state().updatedAt).toBe(0)
    })

    it('is immediately stale when seeded with updatedAt 0', () => {
      const { query } = createQuery<number>()

      query.setData(1, { updatedAt: 0 })

      // updatedAt 0 → stale for any finite staleTime → background refetch.
      expect(query.shouldFetch(1000)).toBe(true)
    })
  })

  describe('invalidate / shouldFetch', () => {
    it('fetches while pending', () => {
      const { query } = createQuery<number>()

      expect(query.shouldFetch(Infinity)).toBe(true)
    })

    it('does not fetch fresh successful data within staleTime', () => {
      const { query } = createQuery<number>()

      query.setData(1)
      expect(query.shouldFetch(Infinity)).toBe(false)
    })

    it('fetches again once invalidated', () => {
      const { query } = createQuery<number>()

      query.setData(1)
      query.invalidate()

      expect(query.state().isInvalidated).toBe(true)
      expect(query.shouldFetch(Infinity)).toBe(true)
    })

    it('fetches again once data is stale', fakeAsync(() => {
      const { query } = createQuery<number>()

      query.setData(1)
      tick(50)
      expect(query.shouldFetch(10)).toBe(true)
    }))

    it('fetches when the last fetch errored', () => {
      const { query } = createQuery<number>()

      query.fetch({ queryFn: () => throwError(() => new Error('boom')) })

      expect(query.state().status).toBe('error')
      expect(query.shouldFetch(Infinity)).toBe(true)
    })
  })

  describe('observers and gc', () => {
    it('counts observers', () => {
      const { query } = createQuery<number>()
      const first = stubObserver()
      const second = stubObserver()

      query.addObserver(first)
      query.addObserver(second)
      expect(query.observerCount).toBe(2)

      query.removeObserver(first)
      expect(query.observerCount).toBe(1)
    })

    it('counts an observer once, however often it is added', () => {
      const { query } = createQuery<number>()
      const observer = stubObserver()

      query.addObserver(observer)
      query.addObserver(observer)
      expect(query.observerCount).toBe(1)
    })

    it('ignores removing an observer it does not have', () => {
      const { query } = createQuery<number>()

      query.addObserver(stubObserver())
      query.removeObserver(stubObserver()) // never added
      expect(query.observerCount).toBe(1)
    })

    it('cancels an in-flight fetch when the last observer leaves', fakeAsync(() => {
      const { query } = createQuery<number>()
      const observer = stubObserver()

      query.addObserver(observer)
      query.fetch({ queryFn: () => Promise.resolve(1) })

      query.removeObserver(observer)
      tick()

      // Fetch was cancelled before it could resolve.
      expect(query.state().status).toBe('pending')
      expect(query.state().data).toBeUndefined()
    }))

    it('schedules gc removal when the last observer leaves', fakeAsync(() => {
      const { query, cache } = createQuery<number>()
      const observer = stubObserver()

      query.setGcTime(1000)
      query.addObserver(observer)

      query.removeObserver(observer)
      expect(cache.remove).not.toHaveBeenCalled()

      tick(1000)
      expect(cache.remove).toHaveBeenCalledWith(query)
    }))

    it('removes immediately when gcTime is 0 and the last observer leaves', fakeAsync(() => {
      const { query, cache } = createQuery<number>()
      const observer = stubObserver()

      query.setGcTime(0)
      query.addObserver(observer)

      query.removeObserver(observer)
      tick(0)

      expect(cache.remove).toHaveBeenCalledWith(query)
    }))

    it('schedules gc for an orphaned setData write (no observers)', fakeAsync(() => {
      const { query, cache } = createQuery<number>()

      query.setGcTime(1000)

      query.setData(1) // no observer → orphaned, must still be collected

      tick(1000)
      expect(cache.remove).toHaveBeenCalledWith(query)
    }))

    it('does not gc a setData write while it has observers', fakeAsync(() => {
      const { query, cache } = createQuery<number>()

      query.setGcTime(1000)
      query.addObserver(stubObserver())

      query.setData(1)

      tick(1000)
      expect(cache.remove).not.toHaveBeenCalled()
    }))

    it('cancels a scheduled gc when an observer returns', fakeAsync(() => {
      const { query, cache } = createQuery<number>()
      const observer = stubObserver()

      query.setGcTime(1000)
      query.addObserver(observer)
      query.removeObserver(observer)

      tick(500)
      query.addObserver(stubObserver())
      tick(1000)

      expect(cache.remove).not.toHaveBeenCalled()
    }))
  })

  describe('refetchIfActive', () => {
    it('fetches nothing while no observer wants the query fetched', () => {
      const { query } = createQuery<number>()

      expect(query.refetchIfActive()).toBeUndefined()

      query.addObserver(stubObserver())
      expect(query.refetchIfActive()).toBeUndefined()
      expect(query.state().isFetching).toBe(false)
    })

    it('fetches as the first observer that wants the query fetched says', () => {
      const { query } = createQuery<number>()
      const first = jasmine.createSpy('first').and.returnValue(of(1))
      const second = jasmine.createSpy('second').and.returnValue(of(2))

      query.addObserver(stubObserver())
      query.addObserver(activeObserver(first))
      query.addObserver(activeObserver(second))
      query.refetchIfActive()

      expect(first).toHaveBeenCalledTimes(1)
      expect(second).not.toHaveBeenCalled()
    })

    it('stops asking an observer once it is removed', () => {
      const { query } = createQuery<number>()
      const first = jasmine.createSpy('first').and.returnValue(of(1))
      const second = jasmine.createSpy('second').and.returnValue(of(2))
      const leaving = activeObserver(first)

      query.addObserver(leaving)
      query.addObserver(activeObserver(second))
      query.removeObserver(leaving)
      query.refetchIfActive()

      expect(first).not.toHaveBeenCalled()
      expect(second).toHaveBeenCalledTimes(1)
    })

    it('replaces a fetch in flight', () => {
      const { query } = createQuery<number>()
      const inFlight = new Subject<number>()

      query.addObserver(activeObserver(() => of(2)))
      query.fetch({ queryFn: () => inFlight })
      query.refetchIfActive()

      // The fetch in flight may predate the change: a new one takes over.
      expect(inFlight.observed).toBe(false)
      expect(query.state().data).toBe(2)
    })
  })

  describe('onFocus / onOnline', () => {
    it('refetches stale data with the first observer that wants it', () => {
      const { query } = createQuery<number>()
      const off = jasmine.createSpy('off').and.returnValue(of(1))
      const on = jasmine.createSpy('on').and.returnValue(of(2))

      query.setData(0, { updatedAt: 0 })
      query.addObserver(stubObserver())
      query.addObserver(activeObserver(off, { refetchOnWindowFocus: false }))
      query.addObserver(activeObserver(on))

      query.onFocus()

      expect(off).not.toHaveBeenCalled()
      expect(on).toHaveBeenCalledTimes(1)
      expect(query.state().data).toBe(2)
    })

    it('lets the first observer that wants it decide how', () => {
      const { query } = createQuery<number>()
      const first = jasmine.createSpy('first').and.returnValue(of(1))
      const second = jasmine.createSpy('second').and.returnValue(of(2))

      query.setData(0, { updatedAt: 0 })
      query.addObserver(activeObserver(first))
      query.addObserver(activeObserver(second))

      query.onFocus()

      expect(first).toHaveBeenCalledTimes(1)
      expect(second).not.toHaveBeenCalled()
    })

    it("doesn't refetch data still fresh for the observer's staleTime", () => {
      const { query } = createQuery<number>()
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))

      query.setData(0)
      query.addObserver(activeObserver(queryFn, { staleTime: Infinity }))

      query.onFocus()
      query.onOnline()

      expect(queryFn).not.toHaveBeenCalled()
    })

    it("refetches fresh data too when the observer says 'always'", () => {
      const { query } = createQuery<number>()
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))

      query.setData(0)
      query.addObserver(
        activeObserver(queryFn, {
          staleTime: Infinity,
          refetchOnWindowFocus: 'always',
        }),
      )

      query.onFocus()

      expect(queryFn).toHaveBeenCalledTimes(1)
    })

    it('refetches data whose last refetch failed, fresh or not', () => {
      const { query } = createQuery<number>()
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(2))

      query.setData(1)
      query.fetch({ queryFn: () => throwError(() => new Error('down')) })

      expect(query.state().status).toBe('error')
      expect(query.state().data).toBe(1)

      query.addObserver(activeObserver(queryFn, { staleTime: Infinity }))
      query.onFocus()

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(query.state().data).toBe(2)
    })

    it("doesn't ask its observers while a fetch is in flight", () => {
      const { query } = createQuery<number>()
      const observer = activeObserver(() => of(2))
      const fetchOptions = spyOn(observer, 'fetchOptions').and.callThrough()

      query.fetch({ queryFn: () => new Subject<number>() })
      query.addObserver(observer)

      query.onFocus()
      query.onOnline()

      expect(fetchOptions).not.toHaveBeenCalled()
      expect(query.state().isFetching).toBe(true)
    })

    it('goes by refetchOnWindowFocus on focus and by refetchOnReconnect on reconnect', () => {
      const { query } = createQuery<number>()
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))

      query.setData(0, { updatedAt: 0 })
      query.addObserver(
        activeObserver(queryFn, {
          refetchOnWindowFocus: false,
          refetchOnReconnect: true,
        }),
      )

      query.onFocus()
      expect(queryFn).not.toHaveBeenCalled()

      query.onOnline()
      expect(queryFn).toHaveBeenCalledTimes(1)
    })
  })
})
