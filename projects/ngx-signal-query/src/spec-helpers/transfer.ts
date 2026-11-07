import {
  APP_ID,
  type EnvironmentProviders,
  PLATFORM_ID,
  type Provider,
  TransferState,
} from '@angular/core'
import { TestBed } from '@angular/core/testing'

type Providers = Array<Provider | EnvironmentProviders>

// The app's id, which names the script the page carries its state in. Set
// here rather than read from TestBed: injecting anything runs the app's
// initializers, which may read the state before the script is in place.
const appId = 'page'

// Sets TestBed up as the server that renders a page.
export function onTheServer(providers: Providers): void {
  TestBed.configureTestingModule({
    providers: [...providers, { provide: PLATFORM_ID, useValue: 'server' }],
  })
}

// What the page carries over to the browser: Angular's TransferState as the
// server writes it into the page once the render is done. Ends the server's
// part: TestBed is reset, ready to be set up as the browser.
export function pageState(): string {
  const state = TestBed.inject(TransferState).toJson()

  TestBed.resetTestingModule()

  return state
}

// Sets TestBed up as the browser that boots from that page. The state sits
// in the document where Angular looks for it, as in a server-rendered page,
// until Angular has read it, the app's initializers included; then it's taken
// out again, so it can't leak into the next spec.
export function inTheBrowser(state: string, providers: Providers): void {
  TestBed.configureTestingModule({
    providers: [...providers, { provide: APP_ID, useValue: appId }],
  })

  const script = document.createElement('script')

  script.id = `${appId}-state`
  script.type = 'application/json'
  script.textContent = state
  document.body.appendChild(script)

  try {
    TestBed.inject(TransferState)
  } finally {
    script.remove()
  }
}
