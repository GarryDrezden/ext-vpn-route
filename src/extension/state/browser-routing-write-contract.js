export const BROWSER_ROUTING_WRITE_CAPABILITY = "browserRoutingWrite";

/** Service-side write error codes forwarded verbatim by the native host. */
export const ServiceWriteErrorCode = Object.freeze({
  InvalidRequest: "invalid_request",
  RevisionConflict: "revision_conflict",
  ValidationFailed: "validation_failed",
  NotFound: "not_found",
  PersistenceFailed: "persistence_failed",
  BrowserStateUnavailable: "browser_state_unavailable"
});

export const WriterErrorCode = Object.freeze({
  UnsupportedCapability: "unsupported_capability",
  TransportUnavailable: "transport_unavailable",
  Timeout: "timeout",
  MalformedResponse: "malformed_response",
  HostError: "host_error"
});

/** After a successful write, run a normal coordinator sync so PAC/state follow Service truth. */
export async function syncAfterBrowserRoutingWrite(coordinator, writeOutcome, reason = "post-write") {
  if (!writeOutcome.ok) return { write: writeOutcome, sync: null };
  const sync = await coordinator.sync(reason);
  return Object.freeze({ write: writeOutcome, sync });
}
