import { Component, inject } from '@angular/core'
import { RouterLink, RouterOutlet } from '@angular/router'
import {
  NgDocNavbarComponent,
  NgDocRootComponent,
  NgDocSidebarComponent,
  NgDocThemeToggleComponent,
} from '@ng-doc/app'
import { NgDocThemeService } from '@ng-doc/app/services/theme'
import { NgDocButtonIconComponent, NgDocTooltipDirective } from '@ng-doc/ui-kit'

@Component({
  selector: 'app-root',
  imports: [
    RouterLink,
    RouterOutlet,
    NgDocRootComponent,
    NgDocNavbarComponent,
    NgDocSidebarComponent,
    NgDocThemeToggleComponent,
    NgDocButtonIconComponent,
    NgDocTooltipDirective,
  ],
  template: `
    <ng-doc-root>
      <ng-doc-navbar [search]="false">
        <a class="brand" routerLink="/" ngDocNavbarLeft>
          <img class="brand-logo" src="logo.svg" alt="" />
          <h3 class="brand-name">ngx-signal-query</h3>
        </a>

        <div class="navbar-right" ngDocNavbarRight>
          <ng-doc-theme-toggle />

          <a
            ng-doc-button-icon
            size="large"
            href="https://github.com/dhutaryan/ngx-signal-query"
            target="_blank"
            rel="noreferrer"
            ngDocTooltip="View on GitHub"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2.17c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.06-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.73 1.27 3.4.97.1-.75.4-1.27.74-1.56-2.56-.29-5.26-1.28-5.26-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.41-5.28 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5Z"
              />
            </svg>
          </a>
        </div>
      </ng-doc-navbar>
      <ng-doc-sidebar />
      <router-outlet />
    </ng-doc-root>
  `,
  styles: [
    `
      .brand {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        text-decoration: none;
        color: inherit;
      }

      .brand-logo {
        display: block;
        width: 28px;
        height: 28px;
      }

      .brand-name {
        margin: 0;
        font-size: 1.1rem;
      }

      .navbar-right {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }

      .navbar-right svg {
        display: block;
        width: 24px;
        height: 24px;
      }
    `,
  ],
})
export class App {
  readonly #theme = inject(NgDocThemeService)

  constructor() {
    this.#theme.set('auto')
  }
}
