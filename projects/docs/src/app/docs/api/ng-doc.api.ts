import { type NgDocApi } from '@ng-doc/core'

const Api: NgDocApi = {
  title: 'API Reference',
  order: 7,
  scopes: [
    {
      name: 'ngx-signal-query',
      route: 'ngx-signal-query',
      include: 'projects/ngx-signal-query/src/lib/**/*.ts',
      exclude: 'projects/ngx-signal-query/src/lib/**/*.spec.ts',
    },
  ],
}

export default Api
