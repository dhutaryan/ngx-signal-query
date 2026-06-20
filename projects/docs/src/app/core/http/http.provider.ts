import { provideHttpClient as provideAngularHttpClient } from '@angular/common/http'
import {
  type EnvironmentProviders,
  makeEnvironmentProviders,
} from '@angular/core'

export function provideHttpClient(): EnvironmentProviders {
  return makeEnvironmentProviders([provideAngularHttpClient()])
}
