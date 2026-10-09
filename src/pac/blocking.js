/**
 * Fail-closed bootstrap PAC uses a proxy directive Chromium rejects at parse time.
 * See net/base/proxy_string_util.h ("foopy:0" INVALID) and mandatory inline PAC
 * (no DIRECT fallback on resolution failure — net/docs/proxy.md).
 *
 * This is not a TCP listen port: no local process can become the intended target
 * the way it can for SOCKS5 127.0.0.1:<ordinary-port>.
 */
export const FAIL_CLOSED_BLOCKING_VR_VPN = "SOCKS5 127.0.0.1:0";
