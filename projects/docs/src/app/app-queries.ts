import { inject, Injectable } from '@angular/core'
import {
  injectQueryClient,
  mutationOptions,
  queryOptions,
} from 'ngx-signal-query'

import { type Recipe, AppRepository } from './app-repository'

@Injectable({ providedIn: 'root' })
export class AppQueries {
  readonly #repository = inject(AppRepository)
  readonly #client = injectQueryClient()

  public recipes() {
    return queryOptions({
      queryKey: ['recipes'],
      queryFn: () => this.#repository.list(),
      retry: (failureCount) => failureCount < 2,
      // Poll every 5s, but stop once a fetch ends in error.
      refetchInterval: (query) =>
        query.state.status === 'error' ? false : 5000,
    })
  }

  public addRecipe() {
    return mutationOptions({
      mutationFn: (name: string) => this.#repository.add(name),
      onMutate: (name) => {
        const previous = this.#client.getQueryData<Recipe[]>(['recipes']) ?? []
        const tempId = Date.now()

        this.#client.setQueryData<Recipe[]>(['recipes'], (prev = []) => [
          ...prev,
          { id: tempId, name },
        ])

        return { previous, tempId }
      },
      // dummyjson /add is a stub (doesn't persist), so instead of
      // invalidating + refetching we swap the temp row for the server reply.
      onSuccess: (created, _name, context) => {
        this.#client.setQueryData<Recipe[]>(['recipes'], (prev = []) =>
          prev.map((recipe) =>
            recipe.id === context?.tempId ? created : recipe,
          ),
        )
      },
      onError: (_error, _name, context) => {
        if (context) {
          this.#client.setQueryData<Recipe[]>(['recipes'], context.previous)
        }
      },
    })
  }
}
