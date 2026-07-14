import { of, Subject } from 'rxjs'

import { MutationCache } from './mutation-cache'

describe('MutationCache', () => {
  let cache: MutationCache

  beforeEach(() => {
    cache = new MutationCache()
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
    it('cancels every mutation and empties the cache', () => {
      const a = cache.build<number, Error, void, unknown>({
        mutationFn: () => new Subject<number>(),
      })
      const b = cache.build<number, Error, void, unknown>({
        mutationFn: () => new Subject<number>(),
      })

      a.execute()
      b.execute()
      spyOn(a, 'cancel')
      spyOn(b, 'cancel')

      cache.clear()

      expect(a.cancel).toHaveBeenCalled()
      expect(b.cancel).toHaveBeenCalled()
      expect(cache.getAll()).toEqual([])
    })
  })
})
