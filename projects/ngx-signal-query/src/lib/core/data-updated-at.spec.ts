import { type Signal } from '@angular/core'
import { TestBed, fakeAsync, tick } from '@angular/core/testing'
import { of, Subject } from 'rxjs'

import { mountHost } from '../../spec-helpers/host'
import { injectQueries } from './inject-queries'
import { injectQuery } from './inject-query'
import { keepPreviousData } from './keep-previous-data'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'
import type { QueryOptions, QueryResult } from './types'

// Exercise the public result of both entry points, including replacement of
// an injectQueries result when its key changes.
for (const kind of ['injectQuery', 'injectQueries'] as const) {
  describe(`${kind} dataUpdatedAt`, () => {
    let client: QueryClient

    function observe<TData>(
      options: () => QueryOptions<TData>,
    ): () => QueryResult<TData> {
      if (kind === 'injectQuery') {
        const result = injectQuery(options)

        return () => result
      }

      const results = injectQueries(() => ({ queries: [options()] }))

      return () => results()[0]
    }

    function mount<TData>(
      options: (id: Signal<number>) => QueryOptions<TData>,
    ) {
      return mountHost<() => QueryResult<TData>, number>(
        (id: Signal<number>) => observe(() => options(id)),
        1,
      )
    }

    beforeEach(() => {
      TestBed.configureTestingModule({ providers: [provideQueryClient()] })
      client = TestBed.inject(QueryClient)
    })

    it('is zero before the first success, including a failed first fetch', fakeAsync(() => {
      const response = new Subject<string>()
      const { created: result } = mount(() => ({
        queryKey: ['empty'],
        queryFn: () => response,
        retry: false,
      }))

      expect(result().dataUpdatedAt()).toBe(0)
      response.error(new Error('synthetic failure'))
      tick()
      expect(result().isError()).toBe(true)
      expect(result().dataUpdatedAt()).toBe(0)
    }))

    it('is zero for a disabled query and an undefined initialData seed', () => {
      const { created: result } = mount<string>(() => ({
        queryKey: ['disabled'],
        queryFn: () => of('fetched'),
        enabled: false,
        initialData: () => undefined,
        initialDataUpdatedAt: 123,
      }))

      expect(result().data()).toBeUndefined()
      expect(result().dataUpdatedAt()).toBe(0)
    })

    it('does not give placeholder data a timestamp', fakeAsync(() => {
      const response = new Subject<string>()
      const { created: result } = mount(() => ({
        queryKey: ['placeholder'],
        queryFn: () => response,
        placeholderData: 'preview',
      }))

      expect(result().data()).toBe('preview')
      expect(result().isPlaceholderData()).toBe(true)
      expect(result().dataUpdatedAt()).toBe(0)
      tick(10)
      response.next('fetched')
      expect(result().dataUpdatedAt()).toBe(Date.now())
      expect(result().isPlaceholderData()).toBe(false)
    }))

    for (const timestamp of [undefined, 0, () => 123]) {
      it(`uses the initialData timestamp (${String(timestamp)})`, fakeAsync(() => {
        const { created: result } = mount(() => ({
          queryKey: ['seed'],
          queryFn: () => of('fetched'),
          initialData: 'seed',
          initialDataUpdatedAt: timestamp,
          staleTime: Infinity,
        }))
        const expected =
          typeof timestamp === 'function'
            ? timestamp()
            : (timestamp ?? Date.now())

        expect(result().data()).toBe('seed')
        expect(result().dataUpdatedAt()).toBe(expected)
      }))
    }

    it('updates on success and cache writes even when the data reference is unchanged', fakeAsync(() => {
      const data = { id: 1 }
      const response = new Subject<typeof data>()
      const { created: result } = mount(() => ({
        queryKey: ['writes'],
        queryFn: () => response,
      }))

      response.next(data)

      const first = result().dataUpdatedAt()
      const reference = result().data()

      expect(first).toBe(Date.now())
      tick(10)
      void result().refetch()
      expect(result().dataUpdatedAt()).toBe(first)
      response.next({ id: 1 })
      expect(result().data()).toBe(reference)
      expect(result().dataUpdatedAt()).toBe(first + 10)
      tick(10)
      client.setQueryData(['writes'], { id: 1 })
      expect(result().data()).toBe(reference)
      expect(result().dataUpdatedAt()).toBe(first + 20)
    }))

    it('uses zero for undefined data but timestamps defined falsy data', fakeAsync(() => {
      const response = new Subject<undefined | null | false | number>()
      const { created: result } = mount(() => ({
        queryKey: ['falsy'],
        queryFn: () => response,
      }))

      response.next(undefined)
      expect(result().isSuccess()).toBe(true)
      expect(result().dataUpdatedAt()).toBe(0)

      for (const data of [null, false, 0] as const) {
        tick(10)
        client.setQueryData(['falsy'], data)
        expect(result().data()).toBe(data)
        expect(result().dataUpdatedAt()).toBe(Date.now())
      }
    }))

    it('preserves the data timestamp through a failed refetch and cancellation', fakeAsync(() => {
      let response = new Subject<string>()
      const { created: result } = mount(() => ({
        queryKey: ['preserve'],
        queryFn: () => response,
        initialData: 'cached',
        initialDataUpdatedAt: 123,
        retry: false,
      }))

      tick(10)
      response.error(new Error('synthetic failure'))
      tick()
      expect(result().isError()).toBe(true)
      expect(result().data()).toBe('cached')
      expect(result().dataUpdatedAt()).toBe(123)
      response = new Subject<string>()
      void result().refetch()
      tick(10)
      client.cancelQueries()
      tick()
      expect(result().isFetching()).toBe(false)
      expect(result().dataUpdatedAt()).toBe(123)
    }))

    it('follows the current key and ignores writes to the previous key', fakeAsync(() => {
      client.setQueryData(['key', 1], 'one')

      const first = Date.now()

      tick(10)
      client.setQueryData(['key', 2], 'two')

      const {
        created: result,
        fixture,
        value,
      } = mount<string>((id) => ({
        queryKey: ['key', id()],
        queryFn: () => of('fetched'),
        enabled: false,
      }))

      expect(result().dataUpdatedAt()).toBe(first)
      value.set(2)
      fixture.detectChanges()
      expect(result().dataUpdatedAt()).toBe(first + 10)
      tick(10)
      client.setQueryData(['key', 1], 'edited')
      expect(result().dataUpdatedAt()).toBe(first + 10)
      value.set(3)
      fixture.detectChanges()
      expect(result().dataUpdatedAt()).toBe(0)
      value.set(1)
      fixture.detectChanges()
      expect(result().dataUpdatedAt()).toBe(first + 20)
    }))

    it('follows a replacement cache object for the same key', fakeAsync(() => {
      client.setQueryData(['replace'], 'old')

      const first = Date.now()
      const old = client.getQueryCache().get<string>(['replace'])!
      const { created: result, fixture } = mount(() => ({
        queryKey: ['replace'],
        queryFn: () => of('fetched'),
        enabled: false,
      }))

      client.removeQueries()
      fixture.detectChanges()
      expect(result().data()).toBe('old')
      expect(result().dataUpdatedAt()).toBe(first)
      tick(10)
      client.setQueryData(['replace'], 'new')
      fixture.detectChanges()
      expect(result().data()).toBe('new')
      expect(result().dataUpdatedAt()).toBe(first + 10)
      old.setData('detached', { updatedAt: 123 })
      expect(result().dataUpdatedAt()).toBe(first + 10)
    }))

    it('keeps the timestamp zero while showing previous data as a placeholder', () => {
      const {
        created: result,
        fixture,
        value,
      } = mount<string>((id) => ({
        queryKey: ['previous', id()],
        queryFn: () => new Subject<string>(),
        placeholderData: keepPreviousData,
      }))

      client.setQueryData(['previous', 1], 'one')
      expect(result().dataUpdatedAt()).toBeGreaterThan(0)
      value.set(2)
      fixture.detectChanges()

      // A new injectQueries entry has no previous observer data to show.
      if (kind === 'injectQuery') {
        expect(result().data()).toBe('one')
        expect(result().isPlaceholderData()).toBe(true)
      }

      expect(result().dataUpdatedAt()).toBe(0)
    })

    it('drives an Angular dependent query key on timestamp changes alone', fakeAsync(() => {
      const response = new Subject<{ id: number }>()
      const keys: unknown[] = []
      const { created, fixture } = mountHost(() => {
        const source = observe(() => ({
          queryKey: ['source'],
          queryFn: () => response,
          retry: false,
        }))
        const dependent = injectQuery(() => {
          const queryKey = ['dependent', source().dataUpdatedAt()]

          return {
            queryKey,
            enabled: source().data() !== undefined,
            queryFn: () => {
              keys.push(queryKey)

              return of('dependent')
            },
          }
        })

        return { source, dependent }
      })

      expect(keys).toEqual([])
      response.next({ id: 1 })
      fixture.detectChanges()

      const first = created.source().dataUpdatedAt()
      const reference = created.source().data()

      expect(keys).toEqual([['dependent', first]])
      tick(10)
      client.setQueryData(['source'], { id: 1 })
      fixture.detectChanges()
      expect(created.source().data()).toBe(reference)
      expect(keys).toEqual([
        ['dependent', first],
        ['dependent', first + 10],
      ])
      expect(created.dependent.data()).toBe('dependent')
      void created.source().refetch()
      response.error(new Error('synthetic refetch failure'))
      tick()
      fixture.detectChanges()
      expect(created.source().isError()).toBe(true)
      expect(created.source().dataUpdatedAt()).toBe(first + 10)
      expect(keys.length).toBe(2)
    }))

    it('passes a list timestamp into a detail seed without making stale data fresh', fakeAsync(() => {
      const old = Date.now() - 60_000
      const queryFn = jasmine
        .createSpy('detail')
        .and.returnValue(new Subject<{ id: number }>())
      const { created } = mountHost(() => {
        const list = observe(() => ({
          queryKey: ['list'],
          queryFn: () => of([{ id: 1 }]),
          initialData: [{ id: 1 }],
          initialDataUpdatedAt: old,
          staleTime: Infinity,
        }))
        const detail = injectQuery(() => ({
          queryKey: ['detail', 1],
          queryFn,
          initialData: () => list().data()?.[0],
          initialDataUpdatedAt: () => list().dataUpdatedAt(),
          staleTime: 30_000,
        }))

        return detail
      })

      expect(created.data()).toEqual({ id: 1 })
      expect(created.dataUpdatedAt()).toBe(old)
      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(created.isFetching()).toBe(true)
    }))
  })
}

describe('injectQueries dataUpdatedAt per entry', () => {
  it('retains independent reactive timestamps when results reorder', fakeAsync(() => {
    TestBed.configureTestingModule({ providers: [provideQueryClient()] })

    const client = TestBed.inject(QueryClient)

    client.setQueryData(['todo', 1], 'one')

    const first = Date.now()

    tick(10)
    client.setQueryData(['todo', 2], 'two')

    const {
      created: results,
      fixture,
      value,
    } = mountHost(
      (ids: Signal<number[]>) =>
        injectQueries(() => ({
          queries: ids().map((id) => ({
            queryKey: ['todo', id],
            queryFn: () => of('fetched'),
            enabled: false,
          })),
        })),
      [1, 2],
    )
    const [one, two] = results()

    expect(one.dataUpdatedAt()).toBe(first)
    expect(two.dataUpdatedAt()).toBe(first + 10)
    value.set([2, 1])
    fixture.detectChanges()
    expect(results()[0]).toBe(two)
    expect(results()[1]).toBe(one)
    tick(10)
    client.setQueryData(['todo', 1], 'edited')
    expect(results().map((result) => result.dataUpdatedAt())).toEqual([
      first + 10,
      first + 20,
    ])
  }))
})
