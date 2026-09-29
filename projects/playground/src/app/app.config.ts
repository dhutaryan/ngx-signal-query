import { provideHttpClient } from '@angular/common/http'
import {
  type ApplicationConfig,
  ErrorHandler,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core'
import { provideRouter } from '@angular/router'
import { provideQueryClient } from 'ngx-signal-query'

import { routes } from './app.routes'
import { LogErrorHandler } from './core/log/log-error-handler'

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideHttpClient(),
    provideQueryClient(),
    { provide: ErrorHandler, useClass: LogErrorHandler },
  ],
}
