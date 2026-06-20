import { Component, inject, signal } from '@angular/core'
import { RouterOutlet } from '@angular/router'
import {
  injectIsFetching,
  injectIsMutating,
  injectMutation,
  injectQuery,
} from 'ngx-signal-query'

import { AppQueries } from './app-queries'

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `
    <h1>Welcome to {{ title() }}!</h1>

    <p>global — fetching: {{ isFetching() }} | mutating: {{ isMutating() }}</p>

    <button (click)="recipes.refetch()">Refetch</button>

    <p>
      recipes status: {{ recipes.status() }} | fetching:
      {{ recipes.isFetching() }} | failures: {{ recipes.failureCount() }}
    </p>

    <ul>
      @for (recipe of recipes.data(); track recipe.id) {
        <li>{{ recipe.name }}</li>
      }
    </ul>

    <hr />

    <button
      (click)="addRecipe.mutate('New recipe')"
      [disabled]="addRecipe.isPending()"
    >
      Add recipe (optimistic)
    </button>

    <p>mutation status: {{ addRecipe.status() }}</p>

    <router-outlet />
  `,
  styles: [],
})
export class App {
  protected readonly title = signal('docs')

  protected readonly recipes = injectQuery(() => this.#queries.recipes())
  protected readonly addRecipe = injectMutation(() => this.#queries.addRecipe())

  protected readonly isFetching = injectIsFetching()
  protected readonly isMutating = injectIsMutating()

  readonly #queries = inject(AppQueries)
}
