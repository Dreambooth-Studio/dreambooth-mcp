/**
 * How long the Studio says a route may take — and therefore how long a call
 * here has to be willing to wait.
 *
 * This file exists because the same mistake was made twice. `save_frame` gave
 * `/api/ai/frames/from-generation` fifteen seconds for work its own route
 * declares `maxDuration = 60` for, and a live write check caught it failing
 * with "may have gone through anyway" — the worst answer this connector can
 * give, because it leaves an operator holding something that may or may not
 * exist. The same gap was then found on four more calls.
 *
 * The rule, stated once so the next person does not have to rediscover it:
 *
 *   **A call must wait slightly LONGER than the route's own ceiling.**
 *
 * Not the same, and never less. If the route runs past its ceiling the
 * platform answers 504, and that answer carries a status this code can map to
 * a sentence. If we abort first we have no status at all — only an
 * AbortError — and for a write the only honest thing left to say is that it
 * may have gone through. Waiting five seconds longer converts an unanswerable
 * failure into a reportable one.
 *
 * The ceiling is NOT ours to choose: it is whatever the Studio declares, in
 * the route's own `export const maxDuration` or in `vercel.json`. When one of
 * those numbers changes, the constant here is what has to change with it.
 */

/**
 * `app/api/projects`, `app/api/sessions` and `app/api/gallery` — the three
 * routes `vercel.json` raises to 30 s, and the only user-facing ones it raises
 * at all. Somebody measured these and decided they needed twice the default;
 * they are also the three heaviest reads in the product.
 */
export const SLOW_ROUTE_BUDGET_MS = 30_000;

/** The margin that lets the route's own answer arrive before we stop listening. */
const ANSWER_MARGIN_MS = 5_000;

/**
 * What a call to one of those routes waits.
 *
 * Comfortably inside the MCP client's own 60 s default, so a tool that hits
 * this still fails with a sentence rather than being abandoned by the client
 * — the constraint that also fixes `SAVE_TIMEOUT_MS` at 45 s.
 */
export const SLOW_ROUTE_TIMEOUT_MS = SLOW_ROUTE_BUDGET_MS + ANSWER_MARGIN_MS;
