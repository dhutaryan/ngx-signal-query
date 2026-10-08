import { of } from 'rxjs'

import {
  hashKey,
  isPlainObject,
  isPromiseLike,
  isValidTimeout,
  partialMatchKey,
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
