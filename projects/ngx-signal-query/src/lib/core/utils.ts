import type { QueryKey, StructuralSharingValue, Updater } from './types'

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
    // An array longer than the key's can't be a prefix of it, even when what
    // it adds is undefined, which an item the key lacks would equal.
    if (Array.isArray(a) && Array.isArray(b) && b.length > a.length) {
      return false
    }

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

// Past this many levels replaceEqualDeep takes the new value as is.
const MAX_SHARING_DEPTH = 500

// Returns `prev` when `next` is deeply equal to it. Otherwise returns `next`
// with every deeply equal part replaced by the one from `prev`, so whatever
// didn't change keeps its reference. Only plain objects and arrays are
// compared, as JSON parsing makes them: any other value (a Date, a class
// instance, a Map) counts as changed. A value that references itself can't
// overflow the stack: past MAX_SHARING_DEPTH levels `next` is taken as is.
// The same algorithm as TanStack Query's replaceEqualDeep.
/** @internal */
export function replaceEqualDeep<T>(prev: unknown, next: T, depth?: number): T

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function replaceEqualDeep(prev: any, next: any, depth = 0): any {
  if (prev === next) return prev
  if (depth > MAX_SHARING_DEPTH) return next

  const array = isPlainArray(prev) && isPlainArray(next)

  if (!array && !(isPlainObject(prev) && isPlainObject(next))) return next

  const prevItems = array ? prev : Object.keys(prev)
  const prevSize = prevItems.length
  const nextItems = array ? next : Object.keys(next)
  const nextSize = nextItems.length
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const copy: any = array ? new Array(nextSize) : {}

  let equalItems = 0

  for (let i = 0; i < nextSize; i++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const key: any = array ? i : nextItems[i]
    const prevItem = prev[key]
    const nextItem = next[key]

    if (prevItem === nextItem) {
      copy[key] = prevItem
      if (array ? i < prevSize : Object.hasOwn(prev, key)) equalItems++
      continue
    }

    if (
      prevItem === null ||
      nextItem === null ||
      typeof prevItem !== 'object' ||
      typeof nextItem !== 'object'
    ) {
      copy[key] = nextItem
      continue
    }

    const shared = replaceEqualDeep(prevItem, nextItem, depth + 1)

    copy[key] = shared
    if (shared === prevItem) equalItems++
  }

  return prevSize === nextSize && equalItems === prevSize ? prev : copy
}

// An array without holes or extra properties, as JSON parsing makes.
function isPlainArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length === Object.keys(value).length
}

// Merges new data into the data a query holds, as its structuralSharing
// option says: shared, as is, or by the option's own function.
/** @internal */
export function replaceData<TData>(
  prevData: TData | undefined,
  data: TData,
  structuralSharing: StructuralSharingValue<TData>,
): TData {
  if (typeof structuralSharing === 'function') {
    return structuralSharing(prevData, data)
  }

  return structuralSharing ? replaceEqualDeep(prevData, data) : data
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
