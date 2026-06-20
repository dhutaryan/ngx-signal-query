import { Injector } from '@angular/core'
import { TestBed, fakeAsync, tick } from '@angular/core/testing'
import { Subject } from 'rxjs'

import { injectIsFetching } from './inject-is-fetching'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'

describe('injectIsFetching', () => {
  let client: QueryClient
  let injector: Injector

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideQueryClient()] })
    client = TestBed.inject(QueryClient)
    injector = TestBed.inject(Injector)
  })

  it('is 0 when nothing is fetching', () => {
    const isFetching = TestBed.runInInjectionContext(() => injectIsFetching())

    expect(isFetching()).toBe(0)
  })

  it('reactively tracks a query through its fetch lifecycle', fakeAsync(() => {
    const subject = new Subject<number>()
    const isFetching = TestBed.runInInjectionContext(() => injectIsFetching())

    expect(isFetching()).toBe(0)

    client.fetchQuery(['a'], () => subject)
    expect(isFetching()).toBe(1)

    subject.next(1)
    subject.complete()
    tick()

    expect(isFetching()).toBe(0)
  }))

  it('counts multiple in-flight queries and honours the key filter', () => {
    const all = injectIsFetching(undefined, { injector })
    const aOnly = injectIsFetching({ queryKey: ['a'] }, { injector })

    client.fetchQuery(['a', 1], () => new Subject<number>())
    client.fetchQuery(['a', 2], () => new Subject<number>())
    client.fetchQuery(['b'], () => new Subject<number>())

    expect(all()).toBe(3)
    expect(aOnly()).toBe(2)
  })

  describe('injection context', () => {
    it('throws when called outside an injection context', () => {
      expect(() => injectIsFetching()).toThrowError(/NG0203|injection context/)
    })

    it('works outside an injection context when given an injector', () => {
      const isFetching = injectIsFetching(undefined, { injector })

      expect(isFetching()).toBe(0)

      client.fetchQuery(['x'], () => new Subject<number>())

      expect(isFetching()).toBe(1)
    })
  })
})
