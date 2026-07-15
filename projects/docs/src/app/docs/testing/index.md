Testing a component that uses `injectQuery` or `injectMutation` comes down to
three things: provide the client, control when the data resolves, and turn off
retries so failing-query tests don't crawl.

## Setup

Provide the query client in `TestBed`, fresh for each test so the cache doesn't
leak between them:

```ts
import { TestBed } from '@angular/core/testing'
import { provideQueryClient } from 'ngx-signal-query'

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [provideQueryClient()],
  })
})
```

A new `TestBed` per test means a new client and an empty cache every time — no
special teardown needed.

## Turn retries off

This is the one that bites. By default a failed query retries **three times with
exponential backoff** — so a test for an error state would sit through seconds of
retries before the query ever reaches `'error'`, and likely time out.

Disable retries for the whole test client:

```ts
import { provideQueryClient, withDefaultOptions } from 'ngx-signal-query'

TestBed.configureTestingModule({
  providers: [
    provideQueryClient(withDefaultOptions({ queries: { retry: false } })),
  ],
})
```

Now a failing query goes straight to `'error'`, synchronously. (Mutations
already default to no retries, so they don't need this.)

## Testing a query

The library has no effects to schedule — its result is pure signals — so you
don't need a rendered component. Two ways to exercise a query:

**In an injection context**, when you're testing the query itself:

```ts
it('exposes the fetched data', () => {
  const todos = TestBed.runInInjectionContext(() =>
    injectQuery(() => ({
      queryKey: ['todos'],
      queryFn: () => of([{ id: 1, title: 'Test' }]), // resolves synchronously
    })),
  )

  expect(todos.status()).toBe('success')
  expect(todos.data()).toEqual([{ id: 1, title: 'Test' }])
})
```

Returning `of(...)` from `queryFn` resolves **synchronously**, so the query is
`'success'` immediately — no waiting.

**In a host component**, when you're testing how a template reacts:

```ts
@Component({
  template: `@if (todos.data(); as data) { {{ data.length }} }`,
})
class Host {
  readonly todos = injectQuery(() => ({
    queryKey: ['todos'],
    queryFn: () => of([{ id: 1, title: 'Test' }]),
  }))
}

it('renders the todos', () => {
  const fixture = TestBed.createComponent(Host)
  fixture.detectChanges()

  expect(fixture.nativeElement.textContent).toContain('1')
})
```

## Asynchronous resolution

To test the loading state, resolve the data on your terms with a `Subject` and
`fakeAsync`:

```ts
it('goes pending, then success', fakeAsync(() => {
  const subject = new Subject<Todo[]>()

  const todos = TestBed.runInInjectionContext(() =>
    injectQuery(() => ({
      queryKey: ['todos'],
      queryFn: () => subject,
    })),
  )

  expect(todos.isPending()).toBe(true)

  subject.next([{ id: 1, title: 'Test' }])
  subject.complete()
  tick()

  expect(todos.isSuccess()).toBe(true)
}))
```

Testing the error path is the same shape — `subject.error(new Error('nope'))`,
then assert `todos.isError()`. (This is where **retries off** matters — otherwise
`tick()` wouldn't be enough.)

## Testing a mutation

Call `mutate()`, then assert the resulting state and any side effects:

```ts
it('adds a todo and invalidates the list', () => {
  const client = TestBed.inject(QueryClient)
  const invalidate = spyOn(client, 'invalidateQueries')

  const addTodo = TestBed.runInInjectionContext(() =>
    injectMutation(() => ({
      mutationFn: (title: string) => of({ id: 1, title }),
      onSuccess: () => client.invalidateQueries({ queryKey: ['todos'] }),
    })),
  )

  addTodo.mutate('Buy milk')

  expect(addTodo.isSuccess()).toBe(true)
  expect(addTodo.data()).toEqual({ id: 1, title: 'Buy milk' })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['todos'] })
})
```

## Test the definitions directly

If you keep queries and mutations in a service with `queryOptions` /
`mutationOptions`, the definitions are plain objects — you can assert on them
with no `TestBed` at all:

```ts
it('builds the right key', () => {
  const queries = new TodoQueries(httpMock)

  expect(queries.detail(5).queryKey).toEqual(['todos', 'detail', 5])
})

it('invalidates on success', () => {
  const options = mutations.add()

  options.onSuccess?.(todo, 'Buy milk', undefined)

  expect(invalidateSpy).toHaveBeenCalled()
})
```

This is the cheapest way to cover your cache logic — the hooks are just
functions.

## Mocking the data layer

The examples above hand `queryFn` an `of(...)` directly, which is usually the
simplest thing: mock the service the `queryFn` calls and have it return an
`Observable`. If you'd rather exercise the real `HttpClient`, provide Angular's
`provideHttpClientTesting()` and drive requests with `HttpTestingController` as
you would for any Angular service — the query library doesn't change that.
