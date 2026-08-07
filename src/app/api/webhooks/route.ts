// Alias for the deposit intake endpoint.
//
// Make.com's URL editor persistently drops the final path segment when saving
// (verified: typing ".../api/webhooks/deposit" three different ways always
// persisted as ".../api/webhooks"). Rather than fight the editor, the deposit
// handler also answers here, so the Make HTTP module works exactly as saved.
//
// /api/webhooks/deposit remains the canonical URL for everything else.
export { POST, GET, maxDuration } from "./deposit/route";
