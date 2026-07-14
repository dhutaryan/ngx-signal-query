import { Injectable, signal } from '@angular/core'

import type { LogEntry, LogKind } from './log.type'

/**
 * Provided at the root, so it outlives the demo component. That's the whole
 * point: it keeps recording hook calls from mutations that are still in flight
 * after their component has been destroyed.
 */
@Injectable({ providedIn: 'root' })
export class Log {
  readonly entries = signal<LogEntry[]>([])

  public add(text: string, kind: LogKind = 'hook'): void {
    const now = new Date()
    const at = `${now.toLocaleTimeString()}.${String(now.getMilliseconds()).padStart(3, '0')}`

    this.entries.update((entries) => [...entries, { at, text, kind }])
  }

  public clear(): void {
    this.entries.set([])
  }
}
