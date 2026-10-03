// Build-time state source: Fixture. `npm run build:extension:native` replaces this module in dist/
// with source-native.js and drops the fixture, so a Native build cannot fall back to it.

import { PHASE3_PROXY_ENDPOINT } from "../runtime/config.js";
import { FIXTURE_NAME, SMOKE_STATE } from "./smoke-state.js";

export const STATE_SOURCE = "Fixture";

export function createStateSource() {
  return Object.freeze({
    mode: STATE_SOURCE,
    fixture: FIXTURE_NAME,
    provider: null,
    builtInState: Object.freeze({ loadState: () => SMOKE_STATE, endpoint: PHASE3_PROXY_ENDPOINT })
  });
}
