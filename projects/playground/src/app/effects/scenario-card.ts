import { ChangeDetectionStrategy, Component, input } from '@angular/core'

import { RUN_LIMIT } from './effect-trace'

/** One counter of a scenario: what happened since the last action, and what should have. */
export type CounterRow = {
  label: string
  actual: number
  expected: number
}

/**
 * Presents one scenario: the effect it runs, its controls (projected), and
 * its counters since the last action next to the numbers expected for it.
 */
@Component({
  selector: 'app-scenario-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h3>
      {{ heading() }}
      <code>{{ api() }}</code>
    </h3>

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
            <td [class.bad]="row.actual !== row.expected">{{ row.actual }}</td>
            <td class="expected">{{ row.expected }}</td>
          </tr>
        }
      </tbody>
    </table>

    @if (stopped()) {
      <p class="stopped">The demo stopped the effect after {{ limit }} runs.</p>
    }
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

      code {
        font-weight: normal;
      }
    }

    code,
    pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      background: #f6f8fa;
      border-radius: 4px;
      font-size: 0.8rem;
    }

    code {
      padding: 0.05rem 0.3rem;
    }

    pre {
      margin: 0 0 0.75rem;
      padding: 0.5rem;
      overflow-x: auto;
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

    .stopped {
      margin: 0.5rem 0 0;
      color: #cf222e;
      font-size: 0.8rem;
      font-weight: 600;
    }
  `,
})
export class ScenarioCard {
  readonly heading = input.required<string>()
  /** The call the scenario exercises, e.g. `fetchQuery`. */
  readonly api = input.required<string>()
  /** The scenario's effect as an app would write it, without the demo's run counter. */
  readonly code = input.required<string>()
  /** The last action: the counters start from it. */
  readonly since = input.required<string>()
  readonly rows = input.required<CounterRow[]>()
  readonly stopped = input.required<boolean>()

  protected readonly limit = RUN_LIMIT
}
