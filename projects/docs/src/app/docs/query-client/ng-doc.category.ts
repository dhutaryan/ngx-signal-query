import { type NgDocCategory } from '@ng-doc/core'

// NgDoc skips categories that have no pages yet, so this stays out of the
// sidebar until its first page lands.
const QueryClient: NgDocCategory = {
  title: 'Query Client',
  order: 6,
  expandable: true,
  expanded: false,
}

export default QueryClient
