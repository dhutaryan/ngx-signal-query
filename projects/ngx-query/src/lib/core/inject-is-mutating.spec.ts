import { Injector } from '@angular/core'
import { TestBed, fakeAsync, tick } from '@angular/core/testing'
import { Subject } from 'rxjs'

import { injectIsMutating } from './inject-is-mutating'
import { injectMutation } from './inject-mutation'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'

describe('injectIsMutating', () => {
  let client: QueryClient
  let injector: Injector

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideQueryClient()] })
    client = TestBed.inject(QueryClient)
    injector = TestBed.inject(Injector)
  })

  it('is 0 when nothing is mutating', () => {
    const isMutating = TestBed.runInInjectionContext(() => injectIsMutating())
    expect(isMutating()).toBe(0)
  })

  it('reactively tracks a mutation through its lifecycle', fakeAsync(() => {
    const subject = new Subject<number>()

    TestBed.runInInjectionContext(() => {
      const isMutating = injectIsMutating()
      const m = injectMutation<number, Error, void>(() => ({
        mutationFn: () => subject,
      }))

      expect(isMutating()).toBe(0)

      m.mutate()
      expect(isMutating()).toBe(1)

      subject.next(1)
      subject.complete()
      tick()

      expect(isMutating()).toBe(0)
    })
  }))

  it('counts multiple concurrent mutations', () => {
    TestBed.runInInjectionContext(() => {
      const isMutating = injectIsMutating()
      const a = injectMutation<number, Error, void>(() => ({
        mutationFn: () => new Subject<number>(),
      }))
      const b = injectMutation<number, Error, void>(() => ({
        mutationFn: () => new Subject<number>(),
      }))

      a.mutate()
      b.mutate()

      expect(isMutating()).toBe(2)
    })
  })

  describe('injection context', () => {
    it('throws when called outside an injection context', () => {
      expect(() => injectIsMutating()).toThrowError(/NG0203|injection context/)
    })

    it('works outside an injection context when given an injector', () => {
      const isMutating = injectIsMutating({ injector })

      expect(isMutating()).toBe(0)

      const mutation = client
        .getMutationCache()
        .build<number, Error, void, unknown>({
          mutationFn: () => new Subject<number>(),
        })
      mutation.execute()

      expect(isMutating()).toBe(1)
    })
  })
})
