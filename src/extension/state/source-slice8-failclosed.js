// Dev-only build input for artifacts/slice8-failclosed-fixture (copied to source.js at build time).

import { FIXTURE_NAME, SMOKE_STATE } from "./smoke-state.js";

export const STATE_SOURCE = "Fixture";

export function createStateSource() {
  return Object.freeze({
    mode: STATE_SOURCE,
    fixture: FIXTURE_NAME,
    provider: null,
    builtInState: Object.freeze({
      loadState: () => SMOKE_STATE,
      failClosedBlocking: true
    })
  });
}
