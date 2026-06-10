import { HttpClient } from '@angular/common/http'
import { inject, Injectable } from '@angular/core'
import { Observable } from 'rxjs'

@Injectable({ providedIn: 'root' })
export class AppRepository {
  private readonly _http = inject(HttpClient)

  public get(id: number): Observable<unknown> {
    return this._http.get(`https://dummyjson.com/recipes/${id}`)
  }

  public add(name: string): Observable<unknown> {
    return this._http.post('https://dummyjson.com/recipes/add', { name })
  }
}
