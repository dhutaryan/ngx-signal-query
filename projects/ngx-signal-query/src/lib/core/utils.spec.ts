import { of } from 'rxjs'

import {
  hashKey,
  isPlainObject,
  isPromiseLike,
  isValidTimeout,
  partialMatchKey,
  replaceData,
  replaceEqualDeep,
} from './utils'

describe('hashKey', () => {
  it('produces a stable string for the same key', () => {
    expect(hashKey(['todos', 1])).toBe(hashKey(['todos', 1]))
  })

  it('is order-independent for object keys', () => {
    expect(hashKey([{ a: 1, b: 2 }])).toBe(hashKey([{ b: 2, a: 1 }]))
  })

  it('is order-independent for an object with a constructor field', () => {
    expect(hashKey([{ constructor: 'x', a: 1 }])).toBe(
      hashKey([{ a: 1, constructor: 'x' }]),
    )
  })

  it('distinguishes different keys', () => {
    expect(hashKey(['todos', 1])).not.toBe(hashKey(['todos', 2]))
  })

  it('preserves array order (arrays are not sorted)', () => {
    expect(hashKey([1, 2])).not.toBe(hashKey([2, 1]))
  })
})

describe('partialMatchKey', () => {
  it('matches when filter is a prefix of the key', () => {
    expect(partialMatchKey(['app', 1], ['app'])).toBe(true)
  })

  it('matches an identical key', () => {
    expect(partialMatchKey(['app', 1], ['app', 1])).toBe(true)
  })

  it('does not match a different prefix', () => {
    expect(partialMatchKey(['app', 1], ['other'])).toBe(false)
  })

  it('does not match when the key is shorter than the filter', () => {
    expect(partialMatchKey(['app'], ['app', 1])).toBe(false)
  })

  it('matches a nested object subset', () => {
    expect(partialMatchKey([{ a: 1, b: 2 }], [{ a: 1 }])).toBe(true)
    expect(partialMatchKey([{ a: 1 }], [{ a: 2 }])).toBe(false)
  })

  it('does not match when value types differ at the same position', () => {
    expect(partialMatchKey(['1'], [1])).toBe(false)
    expect(partialMatchKey([{ a: 1 }], ['a'])).toBe(false)
  })
})

describe('isPlainObject', () => {
  it('returns true for object literals', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject({ a: 1 })).toBe(true)
  })

  it('returns true for null-prototype objects', () => {
    expect(isPlainObject(Object.create(null))).toBe(true)
  })

  it('returns true for an object with its own constructor field', () => {
    expect(isPlainObject(JSON.parse('{"constructor":null}'))).toBe(true)
    expect(isPlainObject({ constructor: 'x' })).toBe(true)
  })

  it('returns false for an object whose prototype has no constructor function', () => {
    expect(isPlainObject(Object.create({ constructor: null }))).toBe(false)
  })

  it('returns false for arrays, null and class instances', () => {
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject(new Date())).toBe(false)
  })
})

describe('replaceEqualDeep', () => {
  it('returns the previous value when the new one is deeply equal', () => {
    const prev = { a: 1, list: [{ id: 1, tags: ['x'] }] }

    expect(
      replaceEqualDeep(prev, { a: 1, list: [{ id: 1, tags: ['x'] }] }),
    ).toBe(prev)
  })

  it("keeps the parts that didn't change", () => {
    const prev = [
      { id: 1, title: 'a', tags: ['x'] },
      { id: 2, title: 'b', tags: ['y'] },
    ]
    const next = [
      { id: 1, title: 'a', tags: ['x'] },
      { id: 2, title: 'b2', tags: ['y'] },
    ]

    const shared = replaceEqualDeep(prev, next)

    expect(shared).toEqual(next)
    expect(shared).not.toBe(prev)
    expect(shared[0]).toBe(prev[0])
    expect(shared[1]).not.toBe(prev[1])
    expect(shared[1].tags).toBe(prev[1].tags)
  })

  it('makes a new object when a key is added, removed or replaced', () => {
    const prev = { a: 1, b: undefined }

    expect(replaceEqualDeep(prev, { a: 1 })).not.toBe(prev)
    expect<unknown>(
      replaceEqualDeep(prev, { a: 1, b: undefined, c: 2 }),
    ).not.toBe(prev)
    // As many keys, and `c` reads undefined in both, but `b` became `c`.
    expect(replaceEqualDeep(prev, { a: 1, c: undefined })).toEqual({
      a: 1,
      c: undefined,
    })
  })

  it('makes a new array when items are added or removed, keeping the rest', () => {
    const prev = [{ id: 1 }, { id: 2 }]
    const longer = replaceEqualDeep(prev, [{ id: 1 }, { id: 2 }, { id: 3 }])
    const shorter = replaceEqualDeep(prev, [{ id: 1 }])

    expect(longer).not.toBe(prev)
    expect(longer[1]).toBe(prev[1])
    expect(shorter).not.toBe(prev)
    expect(shorter[0]).toBe(prev[0])
  })

  it('counts values JSON parsing never makes as changed', () => {
    const prev = { at: new Date(0), tags: ['x'] }
    const next = { at: new Date(0), tags: ['x'] }

    const shared = replaceEqualDeep(prev, next)

    expect(shared).not.toBe(prev)
    expect(shared.at).toBe(next.at)
    expect(shared.tags).toBe(prev.tags)

    const counts = { size: NaN }

    expect(replaceEqualDeep(counts, { size: NaN })).not.toBe(counts)

    // Comparing it item by item would keep the old total.
    const nextPage = Object.assign([1, 2], { total: 3 })

    expect(
      replaceEqualDeep(Object.assign([1, 2], { total: 2 }), nextPage),
    ).toBe(nextPage)
  })

  it('returns the new value as is when there is no previous one', () => {
    const next = { a: 1 }

    expect(replaceEqualDeep(undefined, next)).toBe(next)
  })

  it('stops comparing a value that references itself instead of overflowing', () => {
    const cyclic = (): Record<string, unknown> => {
      const value: Record<string, unknown> = { id: 1 }

      value['self'] = value

      return value
    }

    expect(() => replaceEqualDeep(cyclic(), cyclic())).not.toThrow()
  })
})

describe('replaceData', () => {
  const prev = { a: 1 }

  it('shares with true', () => {
    expect(replaceData(prev, { a: 1 }, true)).toBe(prev)
  })

  it('stores the new data as is with false', () => {
    const next = { a: 1 }

    expect(replaceData(prev, next, false)).toBe(next)
  })

  it('returns what a function makes of the previous and the new data', () => {
    const merged = { a: 2 }
    const merge = jasmine.createSpy('merge').and.returnValue(merged)
    const next = { a: 1 }

    expect(replaceData(prev, next, merge)).toBe(merged)
    expect(merge).toHaveBeenCalledOnceWith(prev, next)
  })
})

describe('isValidTimeout', () => {
  it('accepts a delay a timer can hold', () => {
    expect(isValidTimeout(0)).toBe(true)
    expect(isValidTimeout(1000)).toBe(true)
    expect(isValidTimeout(2 ** 31 - 1)).toBe(true)
  })

  it('rejects a delay a browser would run at once', () => {
    expect(isValidTimeout(Infinity)).toBe(false)
    expect(isValidTimeout(-1)).toBe(false)
    expect(isValidTimeout(2 ** 31)).toBe(false)
    expect(isValidTimeout(NaN)).toBe(false)
  })

  it('rejects anything but a number', () => {
    expect(isValidTimeout(false)).toBe(false)
    expect(isValidTimeout(undefined)).toBe(false)
    expect(isValidTimeout('1000')).toBe(false)
  })
})

describe('isPromiseLike', () => {
  it('accepts a promise or any other thenable', () => {
    expect(isPromiseLike(Promise.resolve(1))).toBe(true)
    expect(isPromiseLike({ then: () => {} })).toBe(true)
  })

  it('rejects anything without a then method', () => {
    expect(isPromiseLike(undefined)).toBe(false)
    expect(isPromiseLike(null)).toBe(false)
    expect(isPromiseLike(1)).toBe(false)
    expect(isPromiseLike({ then: true })).toBe(false)
  })

  it('rejects an Observable, so a hook that returns one is not waited on', () => {
    expect(isPromiseLike(of(1))).toBe(false)
  })
})
