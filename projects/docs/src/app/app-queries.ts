import { inject, Injectable } from '@angular/core'
import { injectQueryClient, mutationOptions, queryOptions } from 'ngx-query'

import { AppRepository, Recipe } from './app-repository'

@Injectable({ providedIn: 'root' })
export class AppQueries {
  private readonly _repository = inject(AppRepository)
  private readonly _client = injectQueryClient()

  public recipes() {
    return queryOptions({
      queryKey: ['recipes'],
      queryFn: () => this._repository.list(),
      retry: (failureCount) => failureCount < 2,
      // Poll every 5s, but stop once a fetch ends in error.
      refetchInterval: (query) => (query.state.status === 'error' ? false : 5000),
    })
  }

  public addRecipe() {
    return mutationOptions({
      mutationFn: (name: string) => this._repository.add(name),
      onMutate: (name) => {
        const previous = this._client.getQueryData<Recipe[]>(['recipes']) ?? []
        const tempId = Date.now()
        this._client.setQueryData<Recipe[]>(['recipes'], (prev = []) => [
          ...prev,
          { id: tempId, name },
        ])
        return { previous, tempId }
      },
      // dummyjson /add is a stub (doesn't persist), so instead of
      // invalidating + refetching we swap the temp row for the server reply.
      onSuccess: (created, _name, context) => {
        this._client.setQueryData<Recipe[]>(['recipes'], (prev = []) =>
          prev.map((recipe) =>
            recipe.id === context?.tempId ? created : recipe,
          ),
        )
      },
      onError: (_error, _name, context) => {
        if (context) {
          this._client.setQueryData<Recipe[]>(['recipes'], context.previous)
        }
      },
    })
  }
}
