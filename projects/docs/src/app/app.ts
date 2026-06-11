import { Component, inject, signal } from '@angular/core'
import { RouterOutlet } from '@angular/router'
import {
  injectIsFetching,
  injectIsMutating,
  injectMutation,
  injectQuery,
} from 'ngx-query'

import { AppQueries } from './app-queries'

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `
    <h1>Welcome to {{ title() }}!</h1>

    <p>global — fetching: {{ isFetching() }} | mutating: {{ isMutating() }}</p>

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

  private readonly _queries = inject(AppQueries)

  protected readonly recipes = injectQuery(() => this._queries.recipes())
  protected readonly addRecipe = injectMutation(() => this._queries.addRecipe())

  protected readonly isFetching = injectIsFetching()
  protected readonly isMutating = injectIsMutating()
}
