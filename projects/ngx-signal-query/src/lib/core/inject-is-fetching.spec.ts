import { Component, Injector, computed, viewChild } from '@angular/core'
import {
  TestBed,
  fakeAsync,
  flushMicrotasks,
  tick,
} from '@angular/core/testing'
import { Subject } from 'rxjs'

import { injectIsFetching } from './inject-is-fetching'
import { injectQueries } from './inject-queries'
import { injectQuery } from './inject-query'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'

@Component({ selector: 'app-todo', template: '' })
class TodoComponent {
  readonly todo = injectQuery(() => ({
    queryKey: ['todo'],
    queryFn: () => new Subject<string>(),
  }))
}

@Component({ selector: 'app-todos', template: '' })
class TodosComponent {
  readonly todos = injectQueries(() => ({
    queries: [1, 2].map((id) => ({
      queryKey: ['todos', id],
      queryFn: () => new Subject<string>(),
    })),
  }))
}

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

  // A query is created on the first read of its result, so a computed that
  // reads a child's query for the first time puts the key in the cache in
  // the middle of its own computation, after it may have read the count.
  describe('a query first read in a computed', () => {
    it('is counted once the computed is done, though it read the count first', fakeAsync(() => {
      @Component({
        imports: [TodoComponent],
        template: '{{ summary() }} <app-todo />',
      })
      class PageComponent {
        readonly isFetching = injectIsFetching()
        readonly child = viewChild(TodoComponent)
        readonly summary = computed(
          () => `${this.isFetching()} ${this.child()?.todo.isFetching()}`,
        )
      }

      const fixture = TestBed.createComponent(PageComponent)

      fixture.detectChanges()
      flushMicrotasks()
      fixture.detectChanges()

      expect(fixture.componentInstance.summary()).toBe('1 true')
      expect(fixture.nativeElement.textContent.trim()).toBe('1 true')
    }))

    it('counts the queries of an injectQueries the computed reads after the count', fakeAsync(() => {
      @Component({
        imports: [TodosComponent],
        template: '{{ summary() }} <app-todos />',
      })
      class PageComponent {
        readonly isFetching = injectIsFetching()
        readonly child = viewChild(TodosComponent)
        readonly summary = computed(() => {
          const count = this.isFetching()
          const todos = this.child()?.todos() ?? []

          return `${count} ${todos.filter((todo) => todo.isFetching()).length}`
        })
      }

      const fixture = TestBed.createComponent(PageComponent)

      fixture.detectChanges()
      flushMicrotasks()
      fixture.detectChanges()

      expect(fixture.componentInstance.summary()).toBe('2 2')
    }))

    it('counts it at once when the computed reads the count after it', () => {
      @Component({
        imports: [TodoComponent],
        template: '{{ summary() }} <app-todo />',
      })
      class PageComponent {
        readonly isFetching = injectIsFetching()
        readonly child = viewChild(TodoComponent)
        readonly summary = computed(() => {
          const fetching = this.child()?.todo.isFetching()

          return `${this.isFetching()} ${fetching}`
        })
      }

      const fixture = TestBed.createComponent(PageComponent)

      fixture.detectChanges()

      // No wait: the count is read once the cache already has the key.
      expect(fixture.componentInstance.summary()).toBe('1 true')
    })
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
