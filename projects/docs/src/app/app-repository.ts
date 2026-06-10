import { HttpClient } from '@angular/common/http'
import { inject, Injectable } from '@angular/core'
import { map, Observable } from 'rxjs'

export type Recipe = { id: number; name: string }

@Injectable({ providedIn: 'root' })
export class AppRepository {
  private readonly _http = inject(HttpClient)

  public list(): Observable<Recipe[]> {
    return this._http
      .get<{ recipes: Recipe[] }>('https://dummyjson.com/recipes?limit=5')
      .pipe(map((response) => response.recipes))
  }

  public add(name: string): Observable<Recipe> {
    return this._http.post<Recipe>('https://dummyjson.com/recipes/add', {
      name,
    })
  }
}
