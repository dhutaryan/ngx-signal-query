import { QueryCache } from './query-cache'

describe('QueryCache', () => {
  let cache: QueryCache

  beforeEach(() => {
    cache = new QueryCache()
  })

  describe('getOrCreate', () => {
    it('creates a query and caches it by key', () => {
      const query = cache.getOrCreate(['todos'])

      expect(query.key).toEqual(['todos'])
      expect(cache.get(['todos'])).toBe(query)
    })

    it('returns the same instance for an equal key (order-independent hash)', () => {
      const a = cache.getOrCreate(['k', { a: 1, b: 2 }])
      const b = cache.getOrCreate(['k', { b: 2, a: 1 }])

      expect(a).toBe(b)
      expect(cache.getAll().length).toBe(1)
    })

    it('creates distinct queries for distinct keys', () => {
      const a = cache.getOrCreate(['a'])
      const b = cache.getOrCreate(['b'])

      expect(a).not.toBe(b)
      expect(cache.getAll().length).toBe(2)
    })
  })

  describe('get', () => {
    it('returns undefined for an unknown key', () => {
      expect(cache.get(['nope'])).toBeUndefined()
    })
  })

  describe('findAll', () => {
    beforeEach(() => {
      cache.getOrCreate(['todos'])
      cache.getOrCreate(['todos', 1])
      cache.getOrCreate(['users'])
    })

    it('returns every query when no filter is given', () => {
      expect(cache.findAll().length).toBe(3)
    })

    it('partial-matches by key prefix', () => {
      const found = cache.findAll({ queryKey: ['todos'] })
      expect(found.map((q) => q.key)).toEqual([['todos'], ['todos', 1]])
    })

    it('matches only the exact key with exact: true', () => {
      const found = cache.findAll({ queryKey: ['todos'], exact: true })
      expect(found.map((q) => q.key)).toEqual([['todos']])
    })
  })

  describe('remove', () => {
    it('drops the query from the cache', () => {
      const query = cache.getOrCreate(['x'])

      cache.remove(query)

      expect(cache.get(['x'])).toBeUndefined()
      expect(cache.getAll()).toEqual([])
    })

    it('only removes the instance currently stored under the key', () => {
      const stale = cache.getOrCreate(['x'])
      cache.remove(stale)

      // A fresh query is created under the same key.
      const current = cache.getOrCreate(['x'])
      expect(current).not.toBe(stale)

      // Removing the stale instance must not evict the current one.
      cache.remove(stale)

      expect(cache.get(['x'])).toBe(current)
    })

    it('is a no-op for a query that is not cached', () => {
      const tracked = cache.getOrCreate(['kept'])
      const orphan = cache.getOrCreate(['orphan'])
      cache.remove(orphan)

      expect(() => cache.remove(orphan)).not.toThrow()
      expect(cache.get(['kept'])).toBe(tracked)
    })
  })

  describe('clear', () => {
    it('destroys every query and empties the cache', () => {
      const a = cache.getOrCreate(['a'])
      const b = cache.getOrCreate(['b'])
      spyOn(a, 'destroy')
      spyOn(b, 'destroy')

      cache.clear()

      expect(a.destroy).toHaveBeenCalled()
      expect(b.destroy).toHaveBeenCalled()
      expect(cache.getAll()).toEqual([])
    })
  })
})
