import { ChangeDetectionStrategy, Component, input } from '@angular/core'

/** One row of a card's table. */
export type CardRow = {
  label: string
  actual: string
  /** What it should be; a row without one isn't judged. */
  expected?: string
  /** Whether actual is wrong. */
  bad: boolean
}

/**
 * The row of a component showing the key. While the cache holds the key, the
 * component should show what the cache holds. Without it, the component may
 * keep what it showed right after the removal: nothing puts the key back on
 * its own.
 *
 * @param cache - What the cache holds for the key; undefined without an entry.
 * @param kept - What the component showed right after the last removal.
 */
export function viewRow(
  label: string,
  actual: string,
  cache: string | undefined,
  kept: string | undefined,
): CardRow {
  const expected = cache ?? kept ?? actual

  return { label, actual, expected, bad: actual !== expected }
}

/**
 * Presents one scenario: the query its components run, its controls
 * (projected), and what each component shows next to what it should show.
 */
@Component({
  selector: 'app-removal-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h3>{{ heading() }}</h3>

    <pre>{{ code() }}</pre>

    <div class="controls">
      <ng-content />
    </div>

    <table class="counters">
      <thead>
        <tr>
          <th>since: {{ since() }}</th>
          <th>actual</th>
          <th>expected</th>
        </tr>
      </thead>
      <tbody>
        @for (row of rows(); track row.label) {
          <tr>
            <td>{{ row.label }}</td>
            <td [class.bad]="row.bad">{{ row.actual }}</td>
            <td class="expected">{{ row.expected ?? '' }}</td>
          </tr>
        }
      </tbody>
    </table>
  `,
  styles: `
    :host {
      display: block;
      border: 1px solid #d0d7de;
      border-radius: 6px;
      padding: 0.75rem;
    }

    h3 {
      margin: 0 0 0.5rem;
      font-size: 0.9rem;
    }

    pre {
      margin: 0 0 0.75rem;
      padding: 0.5rem;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      background: #f6f8fa;
      border-radius: 4px;
      font-size: 0.8rem;
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.4rem;
      margin-bottom: 0.75rem;
      font-size: 0.85rem;
    }

    .counters {
      border-collapse: collapse;
      font-size: 0.85rem;

      th,
      td {
        padding: 0.2rem 0.75rem;
        border-bottom: 1px solid #f0f2f4;
        text-align: right;

        &:first-child {
          text-align: left;
          padding-left: 0;
        }
      }

      th {
        color: #57606a;
        font-weight: normal;
      }

      td {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }

      .bad {
        color: #cf222e;
        font-weight: 600;
      }

      .expected {
        color: #57606a;
      }
    }
  `,
})
export class RemovalCard {
  readonly heading = input.required<string>()
  /** The components' query, as an app would write it. */
  readonly code = input.required<string>()
  /** The last action. */
  readonly since = input.required<string>()
  readonly rows = input.required<CardRow[]>()
}
