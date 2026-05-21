import { HttpClient } from '@angular/common/http'
import { inject, Injectable } from '@angular/core'
import { Observable } from 'rxjs'

@Injectable({ providedIn: 'root' })
export class AppRepository {
  private readonly _http = inject(HttpClient)

  public get(): Observable<unknown> {
    return this._http.get('https://dummyjson.com/recipes/1')
  }
}
