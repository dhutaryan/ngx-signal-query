import {
  Component,
  NgZone,
  TransferState,
  inject,
  input,
  makeStateKey,
  provideAppInitializer,
  viewChild,
} from '@angular/core'
import {
  type ComponentFixture,
  TestBed,
  fakeAsync,
  flushMicrotasks,
  tick,
} from '@angular/core/testing'

import { mountHost } from '../../spec-helpers/host'
import { settled } from '../../spec-helpers/promises'
import {
  inTheBrowser,
  onTheServer,
  pageState,
} from '../../spec-helpers/transfer'
import { withDefaultOptions } from '../features/with-default-options'
import { withHydration } from '../features/with-hydration'
import { TRANSFER_KEY } from './hydration'
import { injectQuery } from './inject-query'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'
import type { QueryResult } from './types'
import { deferred } from './utils'

interface Todo {
  id: number
  title: string
}

// The page both sides render: a todo picked by an input, as a routed
// component gets it, shown once its data is in.
function showTodo({
  queryFn,
  staleTime,
}: {
  queryFn: (id: number) => Promise<Todo>
  staleTime?: number
}): { fixture: ComponentFixture<unknown>; todo: QueryResult<Todo> } {
  @Component({
    selector: 'app-todo',
    template: `
      @if (todo.data(); as data) {
        <h1>{{ data.title }}</h1>
      } @else {
        <p>Loading…</p>
      }
    `,
  })
  class TodoView {
    readonly id = input.required<number>()
    readonly todo = injectQuery(() => ({
      queryKey: ['todo', this.id()],
      queryFn: () => queryFn(this.id()),
      staleTime,
    }))
  }

  @Component({ imports: [TodoView], template: '<app-todo [id]="1" />' })
  class Page {
    readonly view = viewChild.required(TodoView)
  }

  const fixture = TestBed.createComponent(Page)

  fixture.detectChanges()

  return { fixture, todo: fixture.componentInstance.view().todo }
}

// A server render whose components or prefetches `render` sets going. Returns
// the state the page carries over once their data is in.
function renderOnServer(
  render: () => void,
  features = [withHydration()],
): string {
  onTheServer([provideQueryClient(...features)])
  render()
  flushMicrotasks()

  return pageState()
}

describe('withHydration()', () => {
  it("shows the server's data on the first render in the browser, without fetching it while it's fresh", fakeAsync(() => {
    const page = renderOnServer(() =>
      showTodo({
        queryFn: (id) => Promise.resolve({ id, title: 'Write specs' }),
      }),
    )

    inTheBrowser(page, [provideQueryClient(withHydration())])

    const queryFn = jasmine
      .createSpy('queryFn')
      .and.resolveTo({ id: 1, title: 'Fetched again' })
    const { fixture, todo } = showTodo({ queryFn, staleTime: 60_000 })

    expect(fixture.nativeElement.textContent.trim()).toBe('Write specs')
    expect(todo.status()).toBe('success')
    expect(todo.isFetching()).toBe(false)
    expect(queryFn).not.toHaveBeenCalled()
  }))

  it("refetches the server's data in the background once it's stale, and shows it meanwhile", fakeAsync(() => {
    const page = renderOnServer(() =>
      TestBed.inject(QueryClient).fetchQuery(['todos'], () =>
        Promise.resolve('v1'),
      ),
    )

    inTheBrowser(page, [provideQueryClient(withHydration())])

    const response = deferred<string>()
    const queryFn = jasmine
      .createSpy('queryFn')
      .and.returnValue(response.promise)
    const { fixture, created: todos } = mountHost(() =>
      injectQuery(() => ({ queryKey: ['todos'], queryFn })),
    )

    expect(todos.data()).toBe('v1')
    expect(todos.isFetching()).toBe(true)
    expect(queryFn).toHaveBeenCalledTimes(1)

    response.resolve('v2')
    flushMicrotasks()
    fixture.detectChanges()

    expect(todos.data()).toBe('v2')
  }))

  it('keeps the time the server fetched the data, so staleTime counts from then', fakeAsync(() => {
    onTheServer([provideQueryClient(withHydration())])
    showTodo({
      queryFn: (id) => Promise.resolve({ id, title: 'Write specs' }),
    })
    flushMicrotasks()

    const fetchedAt = Date.now()

    // The rest of the page takes a while, and the page reaches the browser a
    // minute after the fetch.
    tick(5_000)

    const page = pageState()

    tick(56_000)
    inTheBrowser(page, [provideQueryClient(withHydration())])

    const queryFn = jasmine
      .createSpy('queryFn')
      .and.resolveTo({ id: 1, title: 'Write specs' })
    const { todo } = showTodo({ queryFn, staleTime: 60_000 })

    expect(todo.dataUpdatedAt()).toBe(fetchedAt)
    expect(queryFn).toHaveBeenCalledTimes(1)
  }))

  it('brings over data the server prefetched with fetchQuery for no component', fakeAsync(() => {
    const page = renderOnServer(() =>
      TestBed.inject(QueryClient).fetchQuery(['user'], () =>
        Promise.resolve('Ann'),
      ),
    )

    inTheBrowser(page, [provideQueryClient(withHydration())])

    expect(TestBed.inject(QueryClient).getQueryData(['user'])).toBe('Ann')
  }))

  it("has the server's data in the cache before an app initializer reads it", fakeAsync(() => {
    const page = renderOnServer(() =>
      TestBed.inject(QueryClient).fetchQuery(['user'], () =>
        Promise.resolve('Ann'),
      ),
    )
    const queryFn = jasmine.createSpy('queryFn').and.resolveTo('Bob')
    let user: { value?: string } = {}

    inTheBrowser(page, [
      provideQueryClient(withHydration()),
      provideAppInitializer(() => {
        user = settled(
          inject(QueryClient).fetchQuery(['user'], queryFn, {
            staleTime: 60_000,
          }),
        )
      }),
    ])
    flushMicrotasks()

    expect(user.value).toBe('Ann')
    expect(queryFn).not.toHaveBeenCalled()
  }))

  it('leaves out a query that failed or never fetched, so the browser loads it', fakeAsync(() => {
    const page = renderOnServer(() => {
      const client = TestBed.inject(QueryClient)

      client.fetchQuery(['todos'], () => Promise.reject(new Error('down')))
      // A refetch that fails keeps the data the query had.
      client.fetchQuery(['user'], () => Promise.resolve('Ann'))
      flushMicrotasks()
      client.fetchQuery(['user'], () => Promise.reject(new Error('down')))
      mountHost(() =>
        injectQuery(() => ({
          queryKey: ['settings'],
          queryFn: () => Promise.resolve('dark'),
          enabled: false,
        })),
      )
    })

    inTheBrowser(page, [provideQueryClient(withHydration())])

    const queryFn = jasmine.createSpy('queryFn').and.resolveTo('fetched')
    const { created } = mountHost(() => ({
      todos: injectQuery(() => ({
        queryKey: ['todos'],
        queryFn,
        staleTime: 60_000,
      })),
      user: injectQuery(() => ({
        queryKey: ['user'],
        queryFn,
        staleTime: 60_000,
      })),
      settings: injectQuery(() => ({
        queryKey: ['settings'],
        queryFn,
        staleTime: 60_000,
      })),
    }))

    expect(created.todos.isLoading()).toBe(true)
    expect(created.user.isLoading()).toBe(true)
    expect(created.settings.isLoading()).toBe(true)
    expect(queryFn).toHaveBeenCalledTimes(3)
  }))

  it('keeps the stale mark invalidateQueries left, so the browser refetches the data however fresh', fakeAsync(() => {
    const page = renderOnServer(() => {
      const client = TestBed.inject(QueryClient)

      client.fetchQuery(['todos'], () => Promise.resolve('v1'))
      flushMicrotasks()
      // No component shows it, so it's only marked.
      client.invalidateQueries({ queryKey: ['todos'] })
    })

    inTheBrowser(page, [provideQueryClient(withHydration())])

    const queryFn = jasmine.createSpy('queryFn').and.resolveTo('v2')
    const { created: todos } = mountHost(() =>
      injectQuery(() => ({ queryKey: ['todos'], queryFn, staleTime: 60_000 })),
    )

    expect(todos.data()).toBe('v1')
    expect(todos.isFetching()).toBe(true)
    expect(queryFn).toHaveBeenCalledTimes(1)
  }))

  it('brings over what the cache holds once the page is done, a write after the fetch included', fakeAsync(() => {
    const page = renderOnServer(() => {
      const client = TestBed.inject(QueryClient)

      client.fetchQuery(['todos'], () => Promise.resolve(['a']))
      flushMicrotasks()
      client.setQueryData<string[]>(['todos'], (todos = []) => [...todos, 'b'])
    })

    inTheBrowser(page, [provideQueryClient(withHydration())])

    expect(TestBed.inject(QueryClient).getQueryData(['todos'])).toEqual([
      'a',
      'b',
    ])
  }))

  it('finds the data under a key with an object in it, whatever order its properties come in', fakeAsync(() => {
    const page = renderOnServer(() =>
      TestBed.inject(QueryClient).fetchQuery(
        ['todos', { page: 1, sort: 'title', search: undefined }],
        () => Promise.resolve(['a']),
      ),
    )

    inTheBrowser(page, [provideQueryClient(withHydration())])

    const queryFn = jasmine.createSpy('queryFn').and.resolveTo(['b'])
    const { created: todos } = mountHost(() =>
      injectQuery(() => ({
        queryKey: ['todos', { search: undefined, sort: 'title', page: 1 }],
        queryFn,
        staleTime: 60_000,
      })),
    )

    expect(todos.data()).toEqual(['a'])
    expect(queryFn).not.toHaveBeenCalled()
  }))

  it('finds the data under a key with a class instance in it', fakeAsync(() => {
    // Hashed as JSON writes it, fields in the order they're declared. The
    // page brings it back as a plain object, whose fields a hash sorts.
    class Filter {
      readonly sort = 'title'
      readonly page = 1
    }

    const page = renderOnServer(() =>
      TestBed.inject(QueryClient).fetchQuery(['todos', new Filter()], () =>
        Promise.resolve(['a']),
      ),
    )

    inTheBrowser(page, [provideQueryClient(withHydration())])

    const queryFn = jasmine.createSpy('queryFn').and.resolveTo(['b'])
    const { created: todos } = mountHost(() =>
      injectQuery(() => ({
        queryKey: ['todos', new Filter()],
        queryFn,
        staleTime: 60_000,
      })),
    )

    expect(todos.data()).toEqual(['a'])
    expect(queryFn).not.toHaveBeenCalled()
  }))

  it('removes data no component shows gcTime after the browser took it over', fakeAsync(() => {
    const page = renderOnServer(() =>
      TestBed.inject(QueryClient).fetchQuery(['user'], () =>
        Promise.resolve('Ann'),
      ),
    )

    inTheBrowser(page, [
      provideQueryClient(
        withDefaultOptions({ queries: { gcTime: 60_000 } }),
        withHydration(),
      ),
    ])

    const client = TestBed.inject(QueryClient)

    tick(59_999)
    expect(client.getQueryData(['user'])).toBe('Ann')

    tick(1)
    expect(client.getQueryData(['user'])).toBeUndefined()
  }))

  it("leaves no timer in Angular's zone for data no component shows yet, so a zone.js app settles", () => {
    onTheServer([provideQueryClient(withHydration())])

    const server = TestBed.inject(QueryClient)

    server.setQueryData(['todos'], ['a'])
    // Data for a @defer block, or for another route.
    server.setQueryData(['user'], 'Ann')

    inTheBrowser(pageState(), [provideQueryClient(withHydration())])
    mountHost(() =>
      injectQuery(() => ({
        queryKey: ['todos'],
        queryFn: () => Promise.resolve(['b']),
        staleTime: 60_000,
      })),
    )

    // With zone.js, the app counts as stable only once no timer is pending in
    // Angular's zone. Until then Angular's own HTTP transfer cache stays on,
    // and answers the app's requests with the server's responses.
    expect(TestBed.inject(NgZone).hasPendingMacrotasks).toBe(false)
  })

  it("drops the page's copy of the cache once the browser has taken it", fakeAsync(() => {
    const page = renderOnServer(() =>
      TestBed.inject(QueryClient).fetchQuery(['user'], () =>
        Promise.resolve('Ann'),
      ),
    )

    inTheBrowser(page, [provideQueryClient(withHydration())])
    TestBed.inject(QueryClient)

    expect(TestBed.inject(TransferState).hasKey(TRANSFER_KEY)).toBe(false)
  }))

  describe("data JSON can't carry as is", () => {
    let warn: jasmine.Spy

    beforeEach(() => (warn = spyOn(console, 'warn')))

    it('leaves the query out, so the browser fetches it, and brings the rest over', fakeAsync(() => {
      const page = renderOnServer(() => {
        const client = TestBed.inject(QueryClient)

        client.fetchQuery(['due'], () => Promise.resolve(new Date(0)))
        client.fetchQuery(['todos'], () => Promise.resolve(['a']))
      })

      inTheBrowser(page, [provideQueryClient(withHydration())])

      const queryFn = jasmine.createSpy('queryFn').and.resolveTo(new Date(1))
      const { created: due } = mountHost(() =>
        injectQuery(() => ({ queryKey: ['due'], queryFn, staleTime: 60_000 })),
      )

      expect(TestBed.inject(QueryClient).getQueryData(['todos'])).toEqual(['a'])
      expect(due.isLoading()).toBe(true)
      expect(queryFn).toHaveBeenCalledTimes(1)
    }))

    it("keeps the rest of the page's state when a value can't be written at all", fakeAsync(() => {
      const theme = makeStateKey<string>('theme')
      const page = renderOnServer(() => {
        const client = TestBed.inject(QueryClient)

        TestBed.inject(TransferState).set(theme, 'dark')
        client.fetchQuery(['count'], () => Promise.resolve(BigInt(1)))
        client.fetchQuery(['todos'], () => Promise.resolve(['a']))
      })

      inTheBrowser(page, [provideQueryClient(withHydration())])

      expect(TestBed.inject(TransferState).get(theme, null)).toBe('dark')
      expect(TestBed.inject(QueryClient).getQueryData(['todos'])).toEqual(['a'])
    }))

    it('warns in development about the query left out for its data, and no other', fakeAsync(() => {
      renderOnServer(() => {
        const client = TestBed.inject(QueryClient)

        client.fetchQuery(['due'], () => Promise.resolve(new Date(0)))
        // Left out too, for their status.
        client.fetchQuery(['todos'], () => Promise.reject(new Error('down')))
        mountHost(() =>
          injectQuery(() => ({
            queryKey: ['user'],
            queryFn: () => Promise.resolve('Ann'),
            enabled: false,
          })),
        )
      })

      expect(warn).toHaveBeenCalledOnceWith(jasmine.stringContaining('["due"]'))
    }))

    it('stays quiet in a production build', fakeAsync(() => {
      const global = globalThis as { ngDevMode?: unknown }
      const devMode = global.ngDevMode

      onTheServer([provideQueryClient(withHydration())])
      TestBed.inject(QueryClient).fetchQuery(['due'], () =>
        Promise.resolve(new Date(0)),
      )
      flushMicrotasks()

      // A production build turns ngDevMode into false.
      global.ngDevMode = false

      try {
        pageState()
      } finally {
        global.ngDevMode = devMode
      }

      expect(warn).not.toHaveBeenCalled()
    }))
  })

  describe('without it on both sides', () => {
    it("doesn't read the page's state in a browser that leaves it out", fakeAsync(() => {
      const page = renderOnServer(() =>
        TestBed.inject(QueryClient).fetchQuery(['user'], () =>
          Promise.resolve('Ann'),
        ),
      )

      inTheBrowser(page, [provideQueryClient()])

      expect(TestBed.inject(QueryClient).getQueryData(['user'])).toBe(undefined)
    }))

    it('writes nothing into the page on a server that leaves it out', fakeAsync(() => {
      const page = renderOnServer(
        () =>
          TestBed.inject(QueryClient).fetchQuery(['user'], () =>
            Promise.resolve('Ann'),
          ),
        [],
      )

      inTheBrowser(page, [provideQueryClient(withHydration())])

      expect(TestBed.inject(QueryClient).getQueryData(['user'])).toBe(undefined)
    }))
  })
})
