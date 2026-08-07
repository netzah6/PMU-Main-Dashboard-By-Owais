// Deposit intake — the original, table-specific URL.
//
// The handler now lives at /api/webhooks and dispatches on the body's `table`
// field (defaulting to deposits), because Make.com's URL editor drops the final
// path segment on save. This path is kept working for everything that already
// points at it.
export { POST, GET, maxDuration } from "../route";
