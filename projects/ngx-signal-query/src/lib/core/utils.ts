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

// Past this many levels survivesJson gives up: a value that references
// itself never ends, and real data is never this deep.
const MAX_JSON_DEPTH = 500

// Whether JSON carries the value over as it is: JSON.parse gives back a value
// equal to it, of the same kind. Strings, finite numbers, booleans, null,
// plain objects and arrays without holes do. A Date, a Map, a class instance,
// a BigInt, NaN, undefined in an array, or a value that references itself
// don't. An object property that's undefined counts as carried: JSON drops
// it, and reading it gives undefined all the same. Symbol keys and extra
// properties on an array aren't checked, and don't make it over.
/** @internal */
export function survivesJson(value: unknown, depth = 0): boolean {
  if (value === null) return true

  if (typeof value === 'string' || typeof value === 'boolean') return true

  // NaN and Infinity come back as null.
  if (typeof value === 'number') return Number.isFinite(value)

  // undefined, a function or a symbol is dropped, or comes back as null; a
  // BigInt can't be written at all.
  if (typeof value !== 'object') return false

  if (depth > MAX_JSON_DEPTH) return false

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      // An item that's undefined, a hole included, comes back as null.
      if (!survivesJson(value[i], depth + 1)) return false
    }

    return true
  }

  // JSON.parse makes objects whose prototype is Object.prototype. Whatever
  // has another one, a Date, a Map, a class instance, comes back as something
  // else. One with none comes back as an ordinary object, which reads the
  // same.
  const prototype = Object.getPrototypeOf(value)

  if (prototype !== Object.prototype && prototype !== null) return false

  // for...in rather than Object.keys(): no array to allocate per object.
  for (const key in value) {
    const item = (value as Record<string, unknown>)[key]

    if (item !== undefined && !survivesJson(item, depth + 1)) return false
  }

  return true
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

// Resolves once every promise has settled, and never rejects. It resolves
// with nothing: what the promises brought isn't the caller's to see.
/** @internal */
export function whenAllSettled(
  promises: Array<Promise<unknown> | undefined>,
): Promise<void> {
  return Promise.allSettled(promises).then(() => undefined)
}

// A promise with the functions that settle it. TODO: use
// Promise.withResolvers() instead once every browser the supported Angular
// versions target has it: Safari 17.4, Chrome 119, Firefox 121 (Angular 20
// still targets Safari 16).
/** @internal */
export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason: unknown) => void
}

/** @internal */
export function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}
