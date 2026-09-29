import {
  Component,
  computed,
  Injector,
  type OnInit,
  type Signal,
  type WritableSignal,
  input,
  signal,
  viewChild,
} from '@angular/core'
import {
  type ComponentFixture,
  TestBed,
  fakeAsync,
  flush,
  tick,
} from '@angular/core/testing'
import { of, Subject, throwError } from 'rxjs'

import { injectQueries, type InjectQueriesOptions } from './inject-queries'
import { injectQuery } from './inject-query'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'
import type { QueryResult } from './types'

// Mounts injectQueries inside a host component so its effects are tied to a
// real view and flush on detectChanges(). The host is rendered from a parent
// template, as in an app, and gets `value` through an `input.required`
// binding: options may read it, although it has no value yet while the host
// is being constructed. Returns the results signal, the parent's `value`
// signal (set it and detectChanges() to push a new input) and the fixture
// (destroy it to unmount).
function mount<TData, TError = Error, TValue = number[]>(
  optionsFn: (value: Signal<TValue>) => InjectQueriesOptions<TData, TError>,
  value?: TValue,
): {
  fixture: ComponentFixture<unknown>
  results: Signal<Array<QueryResult<TData, TError>>>
  value: WritableSignal<TValue>
} {
  @Component({ selector: 'app-host', template: '' })
  class Host {
    readonly value = input.required<TValue>()
    readonly results = injectQueries<TData, TError>(() => optionsFn(this.value))
  }

  @Component({ imports: [Host], template: '<app-host [value]="value()" />' })
  class Parent {
    readonly value = signal(value as TValue)
    readonly host = viewChild.required(Host)
  }

  const fixture = TestBed.createComponent(Parent)

  fixture.detectChanges()

  return {
    fixture,
    results: fixture.componentInstance.host().results,
    value: fixture.componentInstance.value,
  }
}

describe('injectQueries', () => {
  let client: QueryClient

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideQueryClient()] })
    client = TestBed.inject(QueryClient)
  })

  it('returns one result per query, each with its own data', () => {
    const { results } = mount(() => ({
      queries: [1, 2, 3].map((id) => ({
        queryKey: ['todo', id],
        queryFn: () => of(`todo-${id}`),
      })),
    }))

    expect(results().length).toBe(3)
    expect(results().map((todo) => todo.data())).toEqual([
      'todo-1',
      'todo-2',
      'todo-3',
    ])
    expect(results().every((todo) => todo.isSuccess())).toBe(true)
  })

  it('returns an empty array for no queries', () => {
    const { results } = mount<number>(() => ({ queries: [] }))

    expect(results()).toEqual([])
  })

  it('is populated synchronously, before effects run', () => {
    const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))

    @Component({ template: '' })
    class Host {
      readonly results = injectQueries(() => ({
        queries: [{ queryKey: ['sync'], queryFn }],
      }))
    }

    const fixture = TestBed.createComponent(Host)
    const results = fixture.componentInstance.results

    // No change detection yet: the entry exists, the fetch hasn't started.
    expect(results().length).toBe(1)
    expect(results()[0].isPending()).toBe(true)
    expect(queryFn).not.toHaveBeenCalled()
  })

  it('shares cache entries and in-flight requests with injectQuery', () => {
    const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('x'))

    @Component({ template: '' })
    class Host {
      readonly one = injectQuery(() => ({
        queryKey: ['shared'],
        queryFn,
        staleTime: Infinity,
      }))

      readonly many = injectQueries(() => ({
        queries: [{ queryKey: ['shared'], queryFn, staleTime: Infinity }],
      }))
    }

    const fixture = TestBed.createComponent(Host)

    fixture.detectChanges()

    const host = fixture.componentInstance

    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(host.one.data()).toBe('x')
    expect(host.many()[0].data()).toBe('x')
    expect(client.getQueryCache().get(['shared'])?.observerCount).toBe(2)
  })

  it('isolates errors per query', () => {
    const err = new Error('boom')
    const { results } = mount<number>(() => ({
      queries: [
        { queryKey: ['ok'], queryFn: () => of(1) },
        {
          queryKey: ['bad'],
          queryFn: () => throwError(() => err),
          retry: false,
        },
      ],
    }))

    expect(results()[0].isSuccess()).toBe(true)
    expect(results()[0].data()).toBe(1)
    expect(results()[1].isError()).toBe(true)
    expect(results()[1].error()).toBe(err)
  })

  describe('reactive list', () => {
    it('adds a query when a key appears, without refetching the others', () => {
      const ids = signal([1, 2])
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake((id: number) => of(`todo-${id}`))
      const { fixture, results } = mount(() => ({
        queries: ids().map((id) => ({
          queryKey: ['todo', id],
          queryFn: () => queryFn(id),
        })),
      }))

      expect(queryFn.calls.allArgs()).toEqual([[1], [2]])

      ids.set([1, 2, 3])
      fixture.detectChanges()

      expect(results().length).toBe(3)
      expect(results()[2].data()).toBe('todo-3')
      // staleTime defaults to 0, so a refetch of 1 and 2 would show up here.
      expect(queryFn.calls.allArgs()).toEqual([[1], [2], [3]])
    })

    it('removes a query when its key disappears and releases its observer', () => {
      const ids = signal([1, 2, 3])
      const { fixture, results } = mount(() => ({
        queries: ids().map((id) => ({
          queryKey: ['todo', id],
          queryFn: () => of(id),
          staleTime: Infinity,
        })),
      }))
      const cache = client.getQueryCache()
      const [, second, third] = results()

      expect(cache.get(['todo', 1])?.observerCount).toBe(1)

      ids.set([2, 3])
      fixture.detectChanges()

      // Matched by key, not by position: the survivors keep their results.
      expect(results().length).toBe(2)
      expect(results()[0]).toBe(second)
      expect(results()[1]).toBe(third)
      expect(cache.get(['todo', 1])?.observerCount).toBe(0)
      expect(cache.get(['todo', 2])?.observerCount).toBe(1)
      expect(cache.get(['todo', 3])?.observerCount).toBe(1)
    })

    it('keeps result identity across reordering', () => {
      const ids = signal([1, 2, 3])
      const { fixture, results } = mount(() => ({
        queries: ids().map((id) => ({
          queryKey: ['todo', id],
          queryFn: () => of(id),
        })),
      }))
      const [first, second, third] = results()

      ids.set([3, 1, 2])
      fixture.detectChanges()

      expect(results()[0]).toBe(third)
      expect(results()[1]).toBe(first)
      expect(results()[2]).toBe(second)
      expect(results().map((todo) => todo.data())).toEqual([3, 1, 2])
    })

    it('keeps the same array when only options change', () => {
      const version = signal(1)
      const { fixture, results } = mount(() => ({
        queries: [1, 2].map((id) => ({
          queryKey: ['todo', id],
          queryFn: () => of(id),
          retry: version(),
        })),
      }))
      const before = results()

      version.set(2)
      fixture.detectChanges()

      expect(results()).toBe(before)
    })

    it('forwards changed options to the matching query', () => {
      const enabled = signal(false)
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
      const { fixture, results } = mount(() => ({
        queries: [{ queryKey: ['gated'], queryFn, enabled: enabled() }],
      }))

      expect(queryFn).not.toHaveBeenCalled()
      expect(results()[0].isPending()).toBe(true)

      enabled.set(true)
      fixture.detectChanges()

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(results()[0].data()).toBe(1)
    })

    it('pairs duplicate keys one-to-one', () => {
      const count = signal(2)
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('dup'))
      const { fixture, results } = mount(() => ({
        queries: Array.from({ length: count() }, () => ({
          queryKey: ['dup'],
          queryFn,
          staleTime: Infinity,
        })),
      }))
      const query = client.getQueryCache().get(['dup'])

      // Two observers on one cache entry, one request.
      expect(results().length).toBe(2)
      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(query?.observerCount).toBe(2)

      count.set(1)
      fixture.detectChanges()

      expect(results().length).toBe(1)
      expect(query?.observerCount).toBe(1)
    })
  })

  describe('aggregation', () => {
    it('composes with computed', () => {
      const subjects = [new Subject<number>(), new Subject<number>()]
      const { results } = mount(() => ({
        queries: subjects.map((subject, index) => ({
          queryKey: ['agg', index],
          queryFn: () => subject,
        })),
      }))
      const isPending = computed(() =>
        results().some((item) => item.isPending()),
      )
      const total = computed(() =>
        results().reduce((sum, item) => sum + (item.data() ?? 0), 0),
      )

      expect(isPending()).toBe(true)
      expect(total()).toBe(0)

      subjects[0].next(1)
      subjects[0].complete()

      expect(isPending()).toBe(true)
      expect(total()).toBe(1)

      subjects[1].next(2)
      subjects[1].complete()

      expect(isPending()).toBe(false)
      expect(total()).toBe(3)
    })
  })

  describe('lifecycle', () => {
    it('releases every observer when the host is destroyed', () => {
      const { fixture } = mount(() => ({
        queries: [1, 2].map((id) => ({
          queryKey: ['d', id],
          queryFn: () => of(id),
          staleTime: Infinity,
        })),
      }))
      const cache = client.getQueryCache()

      expect(cache.get(['d', 1])?.observerCount).toBe(1)
      expect(cache.get(['d', 2])?.observerCount).toBe(1)

      fixture.destroy()

      expect(cache.get(['d', 1])?.observerCount).toBe(0)
      expect(cache.get(['d', 2])?.observerCount).toBe(0)
    })

    it('stops polling for a removed query', fakeAsync(() => {
      const ids = signal([1, 2])
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake((id: number) => of(id))
      const { fixture } = mount(() => ({
        queries: ids().map((id) => ({
          queryKey: ['p', id],
          queryFn: () => queryFn(id),
          refetchInterval: 100,
        })),
      }))

      expect(queryFn.calls.allArgs()).toEqual([[1], [2]])

      ids.set([1])
      fixture.detectChanges()
      queryFn.calls.reset()

      tick(100)

      // Only the surviving query polls.
      expect(queryFn.calls.allArgs()).toEqual([[1]])

      fixture.destroy()
      flush()
    }))
  })

  // optionsFn may read what a component only has once it's rendered: its
  // inputs, and fields declared after the call. So it must not run while the
  // host is being constructed.
  describe('options evaluation', () => {
    it('does not call optionsFn while the host is being constructed', () => {
      const optionsFn = jasmine.createSpy('optionsFn').and.returnValue({
        queries: [{ queryKey: ['lazy'], queryFn: () => of(1) }],
      })

      @Component({ template: '' })
      class Host {
        readonly results = injectQueries<number>(optionsFn)
      }

      const fixture = TestBed.createComponent(Host)

      expect(optionsFn).not.toHaveBeenCalled()

      fixture.detectChanges()

      expect(optionsFn).toHaveBeenCalled()
      expect(fixture.componentInstance.results()[0].data()).toBe(1)
    })

    it('reads an input.required bound by the parent template', () => {
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake((id: number) => of(`todo-${id}`))
      const { fixture, results, value } = mount(
        (ids) => ({
          queries: ids().map((id) => ({
            queryKey: ['todo', id],
            queryFn: () => queryFn(id),
          })),
        }),
        [1, 2],
      )

      expect(results().map((todo) => todo.data())).toEqual(['todo-1', 'todo-2'])

      value.set([1, 2, 3])
      fixture.detectChanges()

      expect(results().map((todo) => todo.data())).toEqual([
        'todo-1',
        'todo-2',
        'todo-3',
      ])
      expect(queryFn.calls.allArgs()).toEqual([[1], [2], [3]])
    })

    it('reads a field declared after the call', () => {
      @Component({ template: '' })
      class Host {
        readonly results = injectQueries(() => ({
          queries: this.ids().map((id) => ({
            queryKey: ['todo', id],
            queryFn: () => of(`todo-${id}`),
          })),
        }))

        // Declared after the call on purpose: it doesn't exist yet while the
        // queries are being created.
        readonly ids = signal([1, 2])
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()

      expect(
        fixture.componentInstance.results().map((todo) => todo.data()),
      ).toEqual(['todo-1', 'todo-2'])
    })

    it('sees cached data and initialData when read before the first effect run', () => {
      // staleTime 0: once the fetch effects run, both refetch in the
      // background. That no fetch has happened yet by ngOnInit is the proof
      // that the read came first.
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('fresh'))
      let seenInOnInit: unknown[] = []

      client.setQueryData(['cached', 1], 'from cache')

      @Component({ selector: 'app-host', template: '' })
      class Host implements OnInit {
        readonly id = input.required<number>()

        readonly results = injectQueries(() => ({
          queries: [
            { queryKey: ['cached', this.id()], queryFn },
            {
              queryKey: ['seeded', this.id()],
              queryFn,
              initialData: 'from initialData',
            },
          ],
        }))

        ngOnInit(): void {
          seenInOnInit = [
            queryFn.calls.count(),
            ...this.results().map((result) => result.data()),
          ]
        }
      }

      @Component({ imports: [Host], template: '<app-host [id]="1" />' })
      class Parent {}

      TestBed.createComponent(Parent).detectChanges()

      expect(seenInOnInit).toEqual([0, 'from cache', 'from initialData'])
      expect(queryFn).toHaveBeenCalledTimes(2)
    })

    it('creates nothing when first read after the host is destroyed', () => {
      const optionsFn = jasmine.createSpy('optionsFn').and.returnValue({
        queries: [{ queryKey: ['gone'], queryFn: () => of(1) }],
      })

      @Component({ template: '' })
      class Host {
        readonly results = injectQueries<number>(optionsFn)
      }

      const fixture = TestBed.createComponent(Host)
      const { results } = fixture.componentInstance

      // Destroyed before change detection ever ran, and before any read.
      fixture.destroy()

      expect(results()).toEqual([])
      expect(optionsFn).not.toHaveBeenCalled()
      expect(client.getQueryCache().get(['gone'])).toBeUndefined()
    })
  })

  describe('injection context', () => {
    it('throws when called outside an injection context', () => {
      expect(() => injectQueries(() => ({ queries: [] }))).toThrowError(
        /NG0203|injection context/,
      )
    })

    it('works outside an injection context when given an injector', () => {
      const injector = TestBed.inject(Injector)
      const ids = signal([1])
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake((id: number) => of(id * 10))

      const results = injectQueries(
        () => ({
          queries: ids().map((id) => ({
            queryKey: ['inj', id],
            queryFn: () => queryFn(id),
            staleTime: Infinity,
          })),
        }),
        { injector },
      )

      // Effects are tied to the environment injector; flush them explicitly.
      TestBed.tick()

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(results()[0].data()).toBe(10)

      ids.set([1, 2])
      TestBed.tick()

      expect(results().length).toBe(2)
      expect(results()[1].data()).toBe(20)
      expect(queryFn.calls.allArgs()).toEqual([[1], [2]])
    })
  })
})
