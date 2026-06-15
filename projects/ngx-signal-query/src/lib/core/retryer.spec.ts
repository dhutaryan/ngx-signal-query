import { defaultRetryDelay, resolveRetryDelay, shouldRetry } from './retryer'

describe('defaultRetryDelay', () => {
  it('grows exponentially from the failure count', () => {
    expect(defaultRetryDelay(0)).toBe(1000)
    expect(defaultRetryDelay(1)).toBe(2000)
    expect(defaultRetryDelay(2)).toBe(4000)
  })

  it('caps at 30s', () => {
    expect(defaultRetryDelay(100)).toBe(30000)
  })
})

describe('shouldRetry', () => {
  const error = new Error('boom')

  it('retries while the failure count is below the numeric limit', () => {
    expect(shouldRetry(3, 0, error)).toBe(true)
    expect(shouldRetry(3, 2, error)).toBe(true)
    expect(shouldRetry(3, 3, error)).toBe(false)
  })

  it('honours boolean retry values', () => {
    expect(shouldRetry(true, 99, error)).toBe(true)
    expect(shouldRetry(false, 0, error)).toBe(false)
  })

  it('delegates to a predicate function', () => {
    const retry = jasmine
      .createSpy<(count: number, err: Error) => boolean>('retry')
      .and.returnValue(false)

    expect(shouldRetry(retry, 1, error)).toBe(false)
    expect(retry).toHaveBeenCalledWith(1, error)
  })
})

describe('resolveRetryDelay', () => {
  it('returns a constant numeric delay as-is', () => {
    expect(resolveRetryDelay(500, 3, new Error())).toBe(500)
  })

  it('invokes a function delay with the failure count and error', () => {
    const error = new Error('boom')
    const delay = jasmine
      .createSpy<(count: number, err: Error) => number>('delay')
      .and.returnValue(1234)

    expect(resolveRetryDelay(delay, 2, error)).toBe(1234)
    expect(delay).toHaveBeenCalledWith(2, error)
  })
})
