import { QueryKey } from './types'

// True when `filter` is a (deep) prefix of `key`, e.g. ['app'] matches
// ['app', 1]. Used to invalidate/find groups of queries by partial key.
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
export function isPlainObject(o: any): o is Record<PropertyKey, unknown> {
  if (!hasObjectPrototype(o)) {
    return false
  }

  // If has no constructor
  const ctor = o.constructor
  if (ctor === undefined) {
    return true
  }

  // If has modified prototype
  const prot = ctor.prototype
  if (!hasObjectPrototype(prot)) {
    return false
  }

  // If constructor does not have an Object-specific method
  if (!prot.hasOwnProperty('isPrototypeOf')) {
    return false
  }

  // Handles Objects created by Object.create(<arbitrary prototype>)
  if (Object.getPrototypeOf(o) !== Object.prototype) {
    return false
  }

  // Most likely a plain Object
  return true
}

function hasObjectPrototype(o: any): boolean {
  return Object.prototype.toString.call(o) === '[object Object]'
}
