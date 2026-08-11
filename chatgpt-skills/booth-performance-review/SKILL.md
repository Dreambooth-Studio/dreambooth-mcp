---
name: booth-performance-review
description: Review how an operator's Dreambooth photobooths are performing over a period — sessions run, revenue earned, which booths are busy or quiet, and whether each one is actually online. Use for "how did my booths do", "how was last weekend", "which booth is doing best", "is everything running", weekly or monthly reviews, and comparisons between booths.
---

# Reviewing booth performance

The operator wants a picture, not a data dump. Lead with what changed and what needs attention; keep the per-booth detail underneath.

## Order

1. **`list_projects`** — you need the booth `id` before anything can be filtered per booth, and the names let you talk about booths the way the operator does.
2. **`get_sessions`** with a date range — how busy.
3. **`get_revenue_summary`** with the same range — how much. Read `revenue-and-earnings` before quoting any figure.
4. **`get_project`** for a specific booth only when its status matters — it is two calls, so do not run it for every booth by reflex.

Use the operator's own words for a period ("last weekend", "this month") but state the dates you actually used, so a mismatch is visible rather than silent.

## Do not describe a page as the whole

`get_sessions` returns `total`, `returned` and `totalPages`. `returned` is one page. Saying "you ran 20 sessions" when `total` is 52 is wrong, and the operator has no way to tell.

Report the total. Use the rows for detail and examples, never for counting.

## Online vs quiet is not the same as broken

`get_project` returns `liveness` per device. A booth that was deliberately switched off is **not** a fault — most booths are only powered on for events, so "not currently live" is the normal state for a healthy booth between bookings.

Only call something a problem when the operator expected it to be running: a booth quiet during its own event, or a device that stopped mid-session. Reporting a whole fleet as "offline" because it is Tuesday is how this tool loses trust.

`deviceCount: 0` means no device is registered to that booth, which is different from a device being offline. Say which one you found.

## What is worth surfacing unprompted

- A booth with **sessions but no revenue**, or revenue far below its session count
- A gap between `paidSessions` and `completedPaidSessions` — paid sessions that never finished
- A booth that ran nothing at all in a period when others did
- Media counts near zero on a booth that ran sessions (`get_gallery_stats`)

Each is a real operational problem an operator would want to hear about. Mention it in one line; do not turn a performance summary into an audit.

## Comparing booths

Compare within one currency at a time. `mixedCurrency` on the revenue summary means the operator earns in more than one, and there is no exchange rate anywhere in this data — a combined total would be invented.

Sessions can be compared across currencies safely. Money cannot.

## If nothing is connected

Every tool here needs an account. Do not estimate, and do not describe a booth from memory. See `getting-started` for how to connect, which differs by client.
