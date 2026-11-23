import { TestBed } from '@angular/core/testing'
import { type Observable, of, Subject } from 'rxjs'

import type { MutationKey } from './mutation'
import { MutationCache } from './mutation-cache'

describe('MutationCache', () => {
  let cache: MutationCache

  beforeEach(() => {
    // It injects the app's pending tasks for its mutations.
    cache = TestBed.runInInjectionContext(() => new MutationCache())
  })

  describe('build', () => {
    it('creates a mutation, assigns a unique id and caches it', () => {
      const a = cache.build<number, Error, void, unknown>({
        mutationFn: () => of(1),
      })
      const b = cache.build<number, Error, void, unknown>({
        mutationFn: () => of(2),
      })

      expect(a.mutationId).not.toBe(b.mutationId)
      expect(cache.getAll().length).toBe(2)
    })
  })

  describe('findAll', () => {
    it('returns every mutation when no filter is given', () => {
      cache.build<number, Error, void, unknown>({ mutationFn: () => of(1) })
      cache.build<number, Error, void, unknown>({ mutationFn: () => of(2) })

      expect(cache.findAll().length).toBe(2)
    })

    it('filters by status', () => {
      const settled = cache.build<number, Error, void, unknown>({
        mutationFn: () => of(1),
      })
      const pending = cache.build<number, Error, void, unknown>({
        mutationFn: () => new Subject<number>(),
      })

      // injectMutation always observes a run before executing it; an unobserved
      // one drops itself from the cache the moment it settles.
      settled.addObserver()
      pending.addObserver()

      settled.execute() // of() resolves synchronously -> success
      pending.execute() // Subject stays open -> pending

      expect(cache.findAll({ status: 'success' }).length).toBe(1)
      expect(cache.findAll({ status: 'pending' }).length).toBe(1)
      expect(cache.findAll({ status: 'idle' }).length).toBe(0)
    })

    describe('by key', () => {
      // Built, not started: a run that hasn't started stays in the cache with
      // no observer.
      function build(
        mutationKey?: MutationKey,
        mutationFn: () => Observable<number> = () => of(1),
      ) {
        return cache.build<number, Error, void, unknown>({
          mutationKey,
          mutationFn,
        })
      }

      function ids(mutations: Array<{ mutationId: number }>): number[] {
        return mutations.map((mutation) => mutation.mutationId)
      }

      it("matches the runs whose key starts with the filter's key", () => {
        const update = build(['todos', 'update', 1])
        const remove = build(['todos', 'delete', 1])

        build(['users', 'update'])
        build()

        expect(ids(cache.findAll({ mutationKey: ['todos'] }))).toEqual(
          ids([update, remove]),
        )
        expect(
          ids(cache.findAll({ mutationKey: ['todos', 'update'] })),
        ).toEqual(ids([update]))
        expect(
          ids(cache.findAll({ mutationKey: ['todos', 'update', 1] })),
        ).toEqual(ids([update]))
      })

      it("with exact, matches only an equal key, whatever the order of an object's fields", () => {
        const title = build(['todos', { id: 1, field: 'title' }])

        build(['todos', { id: 1, field: 'title' }, 'draft'])
        build(['todos'])

        expect(
          ids(
            cache.findAll({
              mutationKey: ['todos', { field: 'title', id: 1 }],
              exact: true,
            }),
          ),
        ).toEqual(ids([title]))
      })

      it("doesn't match a run without a key to a filter with one, even an empty one", () => {
        const keyed = build(['todos'])
        const keyless = build()

        expect(ids(cache.findAll({ mutationKey: [] }))).toEqual(ids([keyed]))
        expect(ids(cache.findAll({}))).toEqual(ids([keyed, keyless]))
        expect(ids(cache.findAll({ exact: true }))).toEqual(
          ids([keyed, keyless]),
        )
      })

      it('matches the key and the status together', () => {
        const saving = build(['todos', 'update'], () => new Subject<number>())
        const saved = build(['todos', 'update'])
        const other = build(['users', 'update'], () => new Subject<number>())

        // Held, the way injectMutation holds a run, so the one that's done stays.
        for (const run of [saving, saved, other]) {
          run.addObserver()
          run.execute()
        }

        expect(
          ids(cache.findAll({ mutationKey: ['todos'], status: 'pending' })),
        ).toEqual(ids([saving]))
      })
    })
  })

  describe('remove', () => {
    it('drops the mutation from the cache', () => {
      const mutation = cache.build<number, Error, void, unknown>({
        mutationFn: () => of(1),
      })

      cache.remove(mutation)

      expect(cache.getAll()).toEqual([])
    })
  })

  describe('clear', () => {
    it('forgets every mutation, and lets a run in flight go on', () => {
      const response = new Subject<number>()
      const mutation = cache.build<number, Error, void, unknown>({
        mutationFn: () => response,
      })

      cache.build<number, Error, void, unknown>({ mutationFn: () => of(1) })
      mutation.execute()
      cache.clear()

      expect(cache.getAll()).toEqual([])

      response.next(1)
      response.complete()

      // It lands, and doesn't come back into the cache.
      expect(mutation.state().status).toBe('success')
      expect(cache.getAll()).toEqual([])
    })
  })
})
