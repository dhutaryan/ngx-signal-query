import { type NgDocCategory } from '@ng-doc/core'

// NgDoc skips categories that have no pages yet, so this stays out of the
// sidebar until its first page lands.
const Mutations: NgDocCategory = {
  title: 'Mutations',
  order: 4,
  expandable: true,
  expanded: true,
}

export default Mutations
