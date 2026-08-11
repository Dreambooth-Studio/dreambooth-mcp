---
name: booth-troubleshooting
description: Diagnose a Dreambooth photobooth that is not working — printer problems, camera or DSLR issues, a booth that appears offline, sessions failing, photos not appearing in the gallery, payment or connectivity trouble. Use whenever an operator reports something wrong with a booth, mid-event or after.
---

# When a booth is not working

Often the operator is standing next to a broken booth with a queue of guests. Lead with the next thing to try, not with an explanation.

## Start with the documentation, before asking them to connect

`search_docs` needs **no account**. Most booth faults — printer not responding, camera not detected, paper jams, connectivity — have a documented procedure. Search first and give the steps.

Only reach for account data when the docs are not enough, or when the question is specifically about *this* booth's current state.

Never invent a procedure. A wrong instruction about a printer or a DSLR costs the operator an event, not just time. If the docs do not cover it, say so and point at support.

## Then check the booth itself

`list_projects` to find the booth id, then `get_project` for its device status: `liveness`, `lastSeenAt`, `lastActivityAt`, `camera`, `printer`, `internet`, plus disk and memory.

Two readings that matter:

- **Quiet is not broken.** A booth switched off between events is normal. It is only a fault if the operator expected it to be live.
- **`closedAt` / `closedReason`** tell you it was shut down deliberately and why. Check them before calling anything a crash.

`lastSeenAt` versus `lastActivityAt` separates "the machine is on but nothing is happening" from "the machine is gone". Those lead to completely different next steps.

If device monitoring is unavailable the tool returns an empty device list. That is missing information, not a dead booth — say so rather than reporting the booth as offline.

## Photos missing from the gallery

`get_gallery_stats` gives total, active and expired counts.

`expiredCount` is not a fault: media passes out of its retention window by design. If someone cannot find an old photo, check whether it expired before treating it as lost. `totalCount: 0` on a booth that ran sessions is a real problem and worth flagging.

## Sessions that failed

`get_sessions` can be filtered by status and payment channel. A session that took payment but never completed is the case worth spotting — the customer paid and may have received nothing.

## What this connector cannot do

It reads. It cannot restart a booth, reconnect a camera, clear a print queue, re-send a photo, or issue a refund. Say plainly that the fix has to happen on the booth or in the dashboard — never imply an action was taken.

## When to hand over to a human

Escalate to support rather than looping if: the docs have no procedure, the device data looks healthy but the operator says it is not working, hardware may be faulty, or money is involved — a wrong refund answer is worse than no answer. Contact details are in the documentation; `search_docs` will find them.
