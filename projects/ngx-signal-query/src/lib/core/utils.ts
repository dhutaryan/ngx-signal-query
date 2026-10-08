import type { QueryKey, Updater } from './types'

// Resolves an updater: calls it with the previous value if it's a function,
// otherwise uses it as the value directly.
/** @internal */
export function functionalUpdate<TInput, TOutput>(
  updater: Updater<TInput, TOutput>,
  input: TInput,
): TOutput {
  return typeof updater === 'function'
    ? (updater as (input: TInput) => TOutput)(input)
    : updater
}

// True when `filter` is a (deep) prefix of `key`, e.g. ['app'] matches
// ['app', 1]. Used to invalidate/find groups of queries by partial key.
/** @internal */
export function partialMatchKey(key: QueryKey, filter: QueryKey): boolean {
  return partialDeepEqual(key, filter)
}

function partialDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false

  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return Object.keys(b).every((key) =>
      partialDeepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
    )
  }

  return false
}

/** @internal */
export function hashKey(key: QueryKey): string {
  return JSON.stringify(key, (_, value) =>
    isPlainObject(value)
      ? Object.keys(value)
          .sort()
          .reduce<Record<string, unknown>>((result, k) => {
            result[k] = value[k]

            return result
          }, {})
      : value,
  )
}

// Copied from: https://github.com/jonschlinkert/is-plain-object
/** @internal */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isPlainObject(o: any): o is Record<PropertyKey, unknown> {
  if (!hasObjectPrototype(o)) {
    return false
  }

  // If has no constructor. Read from the prototype, not the object: JSON data
  // can have its own `constructor` field, even a null one.
  const objectPrototype = Object.getPrototypeOf(o)
  const ctor = objectPrototype?.constructor

  if (ctor === undefined) {
    return true
  }

  if (typeof ctor !== 'function') {
    return false
  }

  // If has modified prototype
  const prot = ctor.prototype

  if (!hasObjectPrototype(prot)) {
    return false
  }

  // If constructor does not have an Object-specific method
  if (!Object.prototype.hasOwnProperty.call(prot, 'isPrototypeOf')) {
    return false
  }

  // Handles Objects created by Object.create(<arbitrary prototype>)
  if (objectPrototype !== Object.prototype) {
    return false
  }

  // Most likely a plain Object
  return true
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hasObjectPrototype(o: any): boolean {
  return Object.prototype.toString.call(o) === '[object Object]'
}

// The longest delay a browser timer holds, in ms. A longer one overflows and
// the timer fires at once.
const MAX_TIMEOUT = 2 ** 31 - 1

// True for a delay a timer can hold. For anything else, Infinity and negative
// numbers included, a browser runs the timer at once. TanStack's
// isValidTimeout checks the same, without the upper bound.
/** @internal */
export function isValidTimeout(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= MAX_TIMEOUT
}

// True for a promise, or for anything else with a then method.
/** @internal */
export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null)?.then === 'function'
}
