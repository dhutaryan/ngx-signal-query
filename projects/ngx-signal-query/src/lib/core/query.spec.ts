import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing'
import { type Observable, of, Subject, throwError } from 'rxjs'

import { settled } from '../../spec-helpers/promises'
import { CancelledError } from './cancelled-error'
import { Query, type QuerySubscriber } from './query'
import type { QueryCache } from './query-cache'
import { deferred } from './utils'

function createQuery<TData, TError = Error>(gcTime = 5 * 60_000) {
  // Query only calls cache.remove(this) on gc; a stub is enough.
  const cache = { remove: jasmine.createSpy('remove') }
  const query = new Query<TData, TError>({
    key: ['key'],
    queryHash: '["key"]',
    cache: cache as unknown as QueryCache,
    gcTime,
  })

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

  // A retry asks for a queryFn again rather than running the first one once
  // more: one that reads its key's value when it runs may belong to a
  // component that has moved on to another key by then.
  describe('the queryFn a retry runs', () => {
    // A queryFn whose request fails.
    function failing(): jasmine.Spy<() => Observable<number>> {
      return jasmine
        .createSpy('failing')
        .and.returnValue(throwError(() => new Error('down')))
    }

    it("leaves the first attempt to the caller's queryFn", () => {
      const { query } = createQuery<number>()
      const caller = jasmine.createSpy('caller').and.returnValue(of(1))
      const observed = jasmine.createSpy('observed').and.returnValue(of(2))

      query.addObserver(activeObserver(observed))
      query.fetch({ queryFn: caller })

      expect(caller).toHaveBeenCalledTimes(1)
      expect(observed).not.toHaveBeenCalled()
    })

    it('is that of the first observer that wants the query fetched', fakeAsync(() => {
      const { query } = createQuery<number>()
      const started = failing()
      const first = jasmine.createSpy('first').and.returnValue(of(2))
      const second = jasmine.createSpy('second').and.returnValue(of(3))

      query.addObserver(stubObserver())
      query.addObserver(activeObserver(first))
      query.addObserver(activeObserver(second))
      query.fetch({ queryFn: started, retry: 1, retryDelay: 10 })
      tick(10)

      expect(started).toHaveBeenCalledTimes(1)
      expect(first).toHaveBeenCalledTimes(1)
      expect(second).not.toHaveBeenCalled()
      expect(query.state().data).toBe(2)
    }))

    it('counts a queryFn that throws rather than returning as the first attempt', fakeAsync(() => {
      const { query } = createQuery<number>()
      const started = jasmine.createSpy('started').and.throwError('down')
      const observed = jasmine.createSpy('observed').and.returnValue(of(2))

      query.addObserver(activeObserver(observed))
      query.fetch({ queryFn: started, retry: 1, retryDelay: 10 })
      tick(10)

      expect(started).toHaveBeenCalledTimes(1)
      expect(observed).toHaveBeenCalledTimes(1)
    }))

    it('is that of whoever joined the fetch last while no observer wants it fetched', fakeAsync(() => {
      const { query } = createQuery<number>()
      const started = failing()
      const joined = jasmine.createSpy('joined').and.returnValue(of(2))

      query.addObserver(stubObserver())
      query.fetch({ queryFn: started, retry: 1, retryDelay: 10 })
      query.fetch({ queryFn: joined })
      tick(10)

      expect(started).toHaveBeenCalledTimes(1)
      expect(joined).toHaveBeenCalledTimes(1)
      expect(query.state().data).toBe(2)
    }))

    it("is the fetch's own once it replaced another that someone joined", fakeAsync(() => {
      const { query } = createQuery<number>()
      const replacing = jasmine.createSpy('replacing').and.returnValues(
        throwError(() => new Error('down')),
        of(2),
      )
      const joined = jasmine.createSpy('joined')

      query.fetch({ queryFn: () => new Subject<number>() })
      query.fetch({ queryFn: joined })
      query.fetch(
        { queryFn: replacing, retry: 1, retryDelay: 10 },
        { cancelRefetch: true },
      )
      tick(10)

      expect(joined).not.toHaveBeenCalled()
      expect(replacing).toHaveBeenCalledTimes(2)
      expect(query.state().data).toBe(2)
    }))
  })

  describe('fetching after a failure', () => {
    it("goes back to 'pending' with no error while it has no data", () => {
      const { query } = createQuery<number>()

      query.fetch({ queryFn: () => throwError(() => new Error('down')) })
      query.fetch({ queryFn: () => new Subject<number>() })

      expect(query.state()).toEqual(
        jasmine.objectContaining({
          status: 'pending',
          error: null,
          isFetching: true,
          failureCount: 0,
          failureReason: null,
        }),
      )
    })

    it("keeps 'error' and the error while it has data", () => {
      const { query } = createQuery<number>()
      const error = new Error('down')

      query.fetch({ queryFn: () => of(1) })
      query.fetch({ queryFn: () => throwError(() => error) })
      query.fetch({ queryFn: () => new Subject<number>() })

      expect(query.state()).toEqual(
        jasmine.objectContaining({
          data: 1,
          status: 'error',
          error,
          isFetching: true,
        }),
      )
    })
  })

  // A fetch stopped with nothing in its place leaves the query as it was
  // before the fetch, apart from what was written into it meanwhile.
  describe('stopping a fetch', () => {
    // The query failed with `error`, and a fetch tries it again.
    function failedAndTriedAgain(error: Error) {
      const { query } = createQuery<number>()

      query.fetch({ queryFn: () => throwError(() => error) })
      query.fetch({ queryFn: () => new Subject<number>() })

      return query
    }

    it('puts back the status, error and failure fields the fetch started from', () => {
      const error = new Error('down')
      const query = failedAndTriedAgain(error)

      query.cancel()

      expect(query.state()).toEqual(
        jasmine.objectContaining({
          status: 'error',
          error,
          failureCount: 1,
          failureReason: error,
          isFetching: false,
        }),
      )
    })

    it('puts back failure fields that changed while the fetch retried', fakeAsync(() => {
      const { query } = createQuery<number>()
      const first = new Error('first')

      // Two attempts, both failed.
      query.fetch({
        queryFn: () => throwError(() => first),
        retry: 1,
        retryDelay: 10,
      })
      tick(10)
      query.fetch({
        queryFn: () => throwError(() => new Error('second')),
        retry: 1,
        retryDelay: 100,
      })

      // Its first attempt failed, and the retry is waiting.
      expect(query.state().failureCount).toBe(1)

      query.cancel()

      expect(query.state()).toEqual(
        jasmine.objectContaining({
          status: 'error',
          error: first,
          failureCount: 2,
          failureReason: first,
        }),
      )
    }))

    it('goes back to where the first fetch started when another replaced it', () => {
      const error = new Error('down')
      const query = failedAndTriedAgain(error)

      query.fetch(
        { queryFn: () => new Subject<number>() },
        { cancelRefetch: true },
      )
      query.cancel()

      expect(query.state().status).toBe('error')
      expect(query.state().error).toBe(error)
    })

    it('goes back to what was written during the fetch', () => {
      const query = failedAndTriedAgain(new Error('down'))

      query.setData(5)
      query.cancel()

      expect(query.state()).toEqual(
        jasmine.objectContaining({
          status: 'success',
          data: 5,
          error: null,
          isFetching: false,
        }),
      )
    })

    it('keeps a stale mark set during the fetch', () => {
      const { query } = createQuery<number>()

      query.setData(1)
      query.fetch({ queryFn: () => new Subject<number>() })
      query.invalidate()
      query.cancel()

      expect(query.state().isInvalidated).toBe(true)
    })

    it('puts nothing back once the fetch has landed, either way', () => {
      const { query } = createQuery<number>()
      const later = new Error('later')

      query.fetch({ queryFn: () => throwError(() => new Error('down')) })
      query.fetch({ queryFn: () => of(2) })
      query.cancel()

      expect(query.state().status).toBe('success')

      query.fetch({ queryFn: () => throwError(() => later) })
      query.cancel()

      expect(query.state().status).toBe('error')
      expect(query.state().error).toBe(later)
    })

    it('puts nothing back once it has been stopped', () => {
      const query = failedAndTriedAgain(new Error('down'))

      query.cancel()
      query.setData(5)
      query.cancel()

      expect(query.state().status).toBe('success')
      expect(query.state().data).toBe(5)
    })

    it('goes back when the last observer leaves', fakeAsync(() => {
      const error = new Error('down')
      const query = failedAndTriedAgain(error)
      const observer = stubObserver()

      query.addObserver(observer)
      query.removeObserver(observer)

      expect(query.state().status).toBe('error')
      expect(query.state().error).toBe(error)
      expect(query.state().isFetching).toBe(false)
    }))

    it('stops a fetch that its own queryFn cancels while it runs', () => {
      const { query } = createQuery<number>()
      const response = new Subject<number>()

      query.fetch({
        queryFn: () => {
          query.cancel()

          return response
        },
      })

      expect(response.observed).toBe(false)

      response.next(1)

      expect(query.state().status).toBe('pending')
      expect(query.state().data).toBeUndefined()
    })

    it('goes back when the query is destroyed', () => {
      const error = new Error('down')
      const query = failedAndTriedAgain(error)

      query.destroy()

      expect(query.state().status).toBe('error')
      expect(query.state().error).toBe(error)
      expect(query.state().isFetching).toBe(false)
    })
  })

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

    it('cancels an Observable fetch in flight when the last observer leaves', () => {
      const { query } = createQuery<number>()
      const observer = stubObserver()
      const response = new Subject<number>()

      query.addObserver(observer)
      query.fetch({ queryFn: () => response })
      query.removeObserver(observer)

      // Unsubscribed, so an HttpClient request would be aborted.
      expect(response.observed).toBe(false)
      expect(query.state().status).toBe('pending')
      expect(query.state().isFetching).toBe(false)
    })

    it('lets a promise fetch in flight land when the last observer leaves', fakeAsync(() => {
      const { query } = createQuery<number>()
      const observer = stubObserver()

      query.addObserver(observer)
      query.fetch({ queryFn: () => Promise.resolve(1) })
      query.removeObserver(observer)

      // Its request runs to the end anyway.
      expect(query.state().isFetching).toBe(true)

      tick()

      expect(query.state().status).toBe('success')
      expect(query.state().data).toBe(1)
    }))

    it('goes by the request of the last attempt when the last observer leaves', fakeAsync(() => {
      const { query } = createQuery<number>()
      const observer = stubObserver()
      const response = deferred<number>()

      // The first attempt's Observable fails, and the retry sends the promise
      // of a caller that joined meanwhile.
      query.addObserver(observer)
      query.fetch({
        queryFn: () => throwError(() => new Error('down')),
        retry: 1,
        retryDelay: 10,
      })
      query.fetch({ queryFn: () => response.promise })
      tick(10)
      query.removeObserver(observer)
      response.resolve(2)
      flushMicrotasks()

      expect(query.state().data).toBe(2)
    }))

    it("doesn't try a promise fetch again once its last observer left", fakeAsync(() => {
      const { query } = createQuery<number>()
      const observer = stubObserver()
      const error = new Error('down')
      const response = deferred<number>()
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.returnValue(response.promise)

      query.addObserver(observer)
      query.fetch({ queryFn, retry: 3, retryDelay: 10 })
      query.removeObserver(observer)
      response.reject(error)
      flushMicrotasks()

      // It fails at once, with no wait for a retry.
      expect(query.state()).toEqual(
        jasmine.objectContaining({ status: 'error', error, isFetching: false }),
      )

      tick(100)

      expect(queryFn).toHaveBeenCalledTimes(1)
    }))

    it('ends a promise fetch with its error when the wait for a retry is over, if its last observer left during the wait', fakeAsync(() => {
      const { query } = createQuery<number>()
      const observer = stubObserver()
      const error = new Error('down')
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake(() => Promise.reject(error))

      query.addObserver(observer)
      query.fetch({ queryFn, retry: 3, retryDelay: 100 })
      tick(50)
      query.removeObserver(observer)

      expect(query.state().isFetching).toBe(true)

      tick(50)

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(query.state()).toEqual(
        jasmine.objectContaining({
          status: 'error',
          error,
          failureCount: 1,
          isFetching: false,
        }),
      )
    }))

    it('tries a promise fetch again once someone joins it after its last observer left', fakeAsync(() => {
      const { query } = createQuery<number>()
      const observer = stubObserver()
      const response = deferred<number>()
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.returnValues(response.promise, Promise.resolve(2))

      query.addObserver(observer)
      query.fetch({ queryFn, retry: 1, retryDelay: 10 })
      query.removeObserver(observer)
      query.fetch({ queryFn })
      response.reject(new Error('down'))
      tick(10)

      expect(queryFn).toHaveBeenCalledTimes(2)
      expect(query.state().data).toBe(2)
    }))

    it('tries a later fetch again as usual after one its last observer left', fakeAsync(() => {
      const { query } = createQuery<number>()
      const observer = stubObserver()
      // Lands, then fails, then lands.
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake(() =>
          queryFn.calls.count() === 2
            ? Promise.reject(new Error('down'))
            : Promise.resolve(queryFn.calls.count()),
        )

      query.addObserver(observer)
      query.fetch({ queryFn, retry: 1, retryDelay: 10 })
      query.removeObserver(observer)
      flushMicrotasks()
      query.fetch({ queryFn, retry: 1, retryDelay: 10 })
      tick(10)

      expect(queryFn).toHaveBeenCalledTimes(3)
      expect(query.state().data).toBe(3)
    }))

    it('removes a query nothing uses gcTime after it is created', fakeAsync(() => {
      const { query, cache } = createQuery<number>(1000)

      tick(999)
      expect(cache.remove).not.toHaveBeenCalled()

      tick(1)
      expect(cache.remove).toHaveBeenCalledWith(query)
    }))

    it('schedules gc removal when the last observer leaves', fakeAsync(() => {
      const { query, cache } = createQuery<number>(1000)
      const observer = stubObserver()

      query.addObserver(observer)

      query.removeObserver(observer)
      expect(cache.remove).not.toHaveBeenCalled()

      tick(1000)
      expect(cache.remove).toHaveBeenCalledWith(query)
    }))

    it('removes immediately when gcTime is 0 and the last observer leaves', fakeAsync(() => {
      const { query, cache } = createQuery<number>(0)
      const observer = stubObserver()

      query.addObserver(observer)

      query.removeObserver(observer)
      tick(0)

      expect(cache.remove).toHaveBeenCalledWith(query)
    }))

    it('schedules gc for an orphaned setData write (no observers)', fakeAsync(() => {
      const { query, cache } = createQuery<number>(1000)

      query.setData(1) // no observer → orphaned, must still be collected

      tick(1000)
      expect(cache.remove).toHaveBeenCalledWith(query)
    }))

    it('does not gc a setData write while it has observers', fakeAsync(() => {
      const { query, cache } = createQuery<number>(1000)

      query.addObserver(stubObserver())

      query.setData(1)

      tick(1000)
      expect(cache.remove).not.toHaveBeenCalled()
    }))

    it('never removes a query whose gcTime is Infinity, or more than a timer can hold', async () => {
      // A browser runs a timer it can't hold at once. fakeAsync doesn't mimic
      // the browser here, hence real timers.
      for (const gcTime of [Infinity, 2 ** 31]) {
        const { query, cache } = createQuery<number>(gcTime)
        const observer = stubObserver()

        query.addObserver(observer)
        query.removeObserver(observer)
        query.setData(1)
        await new Promise((resolve) => setTimeout(resolve, 20))

        expect(cache.remove).not.toHaveBeenCalled()
      }
    })

    it('cancels a scheduled gc when an observer returns', fakeAsync(() => {
      const { query, cache } = createQuery<number>(1000)
      const observer = stubObserver()

      query.addObserver(observer)
      query.removeObserver(observer)

      tick(500)
      query.addObserver(stubObserver())
      tick(1000)

      expect(cache.remove).not.toHaveBeenCalled()
    }))

    it('keeps the longest gcTime it was given', fakeAsync(() => {
      const { query, cache } = createQuery<number>(1000)
      const observer = stubObserver()

      query.updateGcTime(60_000)
      query.updateGcTime(500)
      query.addObserver(observer)
      query.removeObserver(observer)

      tick(59_999)
      expect(cache.remove).not.toHaveBeenCalled()

      tick(1)
      expect(cache.remove).toHaveBeenCalledWith(query)
    }))

    it('treats a negative gcTime as 0', fakeAsync(() => {
      const { query, cache } = createQuery<number>(-1)
      const observer = stubObserver()

      query.addObserver(observer)
      query.removeObserver(observer)
      tick(0)

      expect(cache.remove).toHaveBeenCalledWith(query)
    }))

    it('lets the next gcTime replace a NaN one', fakeAsync(() => {
      const { query, cache } = createQuery<number>(NaN)
      const observer = stubObserver()

      query.updateGcTime(1000)
      query.addObserver(observer)
      query.removeObserver(observer)

      tick(999)
      expect(cache.remove).not.toHaveBeenCalled()

      tick(1)
      expect(cache.remove).toHaveBeenCalledWith(query)
    }))

    it('keeps a query while a fetch of it is in flight, and removes it gcTime after the fetch lands', fakeAsync(() => {
      const { query, cache } = createQuery<number>(1000)
      const response = new Subject<number>()

      query.setData(1)
      tick(500)
      query.fetch({ queryFn: () => response })
      tick(700)
      expect(cache.remove).not.toHaveBeenCalled()

      response.next(2)
      response.complete()
      tick(999)
      expect(cache.remove).not.toHaveBeenCalled()

      tick(1)
      expect(cache.remove).toHaveBeenCalledWith(query)
    }))

    it('removes a query nobody observes gcTime after a fetch of it fails', fakeAsync(() => {
      const { query, cache } = createQuery<number>(1000)
      const response = new Subject<number>()

      query.fetch({ queryFn: () => response })
      tick(500)
      response.error(new Error('down'))
      tick(999)
      expect(cache.remove).not.toHaveBeenCalled()

      tick(1)
      expect(cache.remove).toHaveBeenCalledWith(query)
    }))

    it('removes a query nobody observes gcTime after a fetch of it is cancelled', fakeAsync(() => {
      const { query, cache } = createQuery<number>(1000)

      query.fetch({ queryFn: () => new Subject<number>() })
      tick(1500)
      query.cancel()
      tick(999)
      expect(cache.remove).not.toHaveBeenCalled()

      tick(1)
      expect(cache.remove).toHaveBeenCalledWith(query)
    }))

    it("doesn't put off gc when there's no fetch to cancel", fakeAsync(() => {
      const { query, cache } = createQuery<number>(1000)

      query.setData(1)
      tick(600)
      query.cancel()
      tick(400)

      expect(cache.remove).toHaveBeenCalledWith(query)
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
