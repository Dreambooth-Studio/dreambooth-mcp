---
name: revenue-and-earnings
description: Answer money questions about a Dreambooth operator's booths correctly — earnings, revenue, payouts, wallet balance, credits, payment channels. Use whenever someone asks what they earned, how much a booth made, where the money went, or how much is available to withdraw. Read this before quoting any figure, because the obvious tool is the wrong one for "how much did I earn".
---

# Money questions

Dreambooth holds money facts in two different places that answer two different questions. Choosing the wrong one produces a number that is confidently, specifically wrong — and it will usually be **too low**, which an operator may act on.

## The rule that matters most

> **For "how much did I earn", use `get_revenue_summary`. Never the wallet ledger.**

`get_wallet_transactions` is the **wallet ledger**: gateway settlement and withdrawals. It **excludes cash and voucher income entirely.** For any operator who takes cash — most of them — it understates real income, sometimes drastically.

| Question | Tool |
|---|---|
| What did I earn? How did a booth perform? | `get_revenue_summary` |
| What has moved through my wallet? What can I withdraw? | `get_wallet_transactions` |
| How many AI credits do I have? | `get_credits` |

If someone asks a wallet question, answer it from the wallet — just never present the wallet as their earnings.

## Reading `get_revenue_summary` correctly

**`revenue` is main + reprint.** `aiEffectRevenue` is reported **separately and is not inside it**. Do not add them together and call the result revenue; if AI effects matter to the question, name that figure separately.

**Never sum across currencies.** When `mixedCurrency` is true, the operator has income in more than one currency. Report each currency on its own line. There is no exchange rate anywhere in this data, so adding them produces a meaningless number.

**`paidSessions` vs `completedPaidSessions` is worth surfacing.** The gap is sessions that were paid for but never finished — money taken for something the customer may not have received. If the gap is non-trivial, say so; it is usually more useful than the headline figure.

**`reconciliation.unaccounted`**, when present, is the difference between lifetime revenue and what the requested buckets cover. It is only meaningful for an unbounded query. Do not present it as missing money for a date-filtered question.

Buckets come newest first, and periods with no activity are omitted rather than returned as zero. A missing month means nothing happened, not that data is lost.

## Reading the wallet ledger correctly

`truncated: true` means you are looking at a **window, not the whole ledger**. Never describe a truncated list as "your transactions" — say how many were returned out of how many exist, or ask for a narrower date range.

Rows carry fees. If someone asks what they actually received, the fee breakdown is on the row; do not quote the gross amount as the payout.

## Credits are not money

`get_credits` returns AI credits and the subscription plan. Credits pay for AI effects. They are not currency, cannot be withdrawn, and must never be added to or compared with a revenue figure.

## What this connector cannot do

It reads. It cannot move money, request or cancel a withdrawal, issue a refund, or change a transaction. Withdrawals and payout accounts are permanently outside its scope. If someone asks for any of those, say plainly that it has to be done in the Dreambooth dashboard — do not imply it was done.

## If nothing is connected

Any of these tools will say no account is connected. Do not guess a number, and do not describe a booth's earnings from memory. Run `connect_account`, give them the link, and answer once they have approved.
