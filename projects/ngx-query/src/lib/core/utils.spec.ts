import { hashKey, isPlainObject, partialMatchKey } from './utils'

describe('hashKey', () => {
  it('produces a stable string for the same key', () => {
    expect(hashKey(['todos', 1])).toBe(hashKey(['todos', 1]))
  })

  it('is order-independent for object keys', () => {
    expect(hashKey([{ a: 1, b: 2 }])).toBe(hashKey([{ b: 2, a: 1 }]))
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

  it('returns false for arrays, null and class instances', () => {
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject(new Date())).toBe(false)
  })
})
