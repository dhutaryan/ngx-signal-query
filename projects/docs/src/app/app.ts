import { Component, inject, signal } from '@angular/core'
import { RouterOutlet } from '@angular/router'
import { injectQuery, injectQueryClient } from 'ngx-query'

import { AppQueries } from './app-queries'
import { JsonPipe } from '@angular/common'

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, JsonPipe],
  template: `
    <h1>Welcome to {{ title() }}!</h1>

    <button (click)="loadRandom()">Load random</button>
    <button (click)="invalidateCurrent()">Invalidate current</button>
    <button (click)="invalidateAll()">Invalidate all</button>

    <p>
      id: {{ recipeId() }} | status: {{ query.status() }} | fetching:
      {{ query.isFetching() }}
    </p>

    <pre>{{ query.data() | json }}</pre>

    <router-outlet />
  `,
  styles: [],
})
export class App {
  protected readonly title = signal('docs')
  protected readonly recipeId = signal(1)

  private readonly _queries = inject(AppQueries)
  private readonly _client = injectQueryClient()

  protected readonly query = injectQuery(() =>
    this._queries.recipe(this.recipeId()),
  )

  protected loadRandom(): void {
    this.recipeId.set(Math.floor(Math.random() * 5) + 1)
  }

  protected invalidateCurrent(): void {
    this._client.invalidateQueries({ queryKey: ['app', this.recipeId()] })
  }

  protected invalidateAll(): void {
    this._client.invalidateQueries({ queryKey: ['app'] })
  }
}
