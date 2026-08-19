---
name: creating-filters-and-booths
description: Create a photo filter from a description of the look an operator wants, or copy a booth they already run. Use for "make me a filter that looks…", "I want a warm faded look", "set up another booth like my Bandung one", "duplicate this booth for Saturday". Read this before creating anything, because these are the only two tools here that change an account, calling one twice makes two of the thing, and neither can undo or edit what it made.
---

# Making things on an operator's account

Two tools here create something. Everything else only reads. They are the only
calls in this connector that leave an account different from how they found it,
and neither of them can be reversed from this conversation.

| They ask for | Tool |
|---|---|
| A new photo filter, from a described look | `create_filter` |
| Another booth like one they already run | `duplicate_project` |

## Before you call either one

**Say what you are about to make, in their words, and let them answer.** The
host shows its own approval dialog, but that dialog shows arguments, not intent
— "contrast 112, saturation 88" is not something an operator can check. A
sentence they can agree or object to is: *"A filter called Senja Hangat — warmer,
slightly faded, a little less contrast. Make it?"*

**Neither tool can edit or delete.** There is no tool here that changes an
existing filter or booth, and there will not be one — the connector cannot PUT
or DELETE anything. If they want to adjust what exists, or remove something,
send them to the dashboard. Do not offer to "fix" a filter by making another one
unless they ask for that.

**Calling twice makes two.** Both tools are non-idempotent and say so in their
annotations. If a call times out, do NOT repeat it — the write may have
succeeded and only the reply went missing. Tell them to check their dashboard
first. Repeating a read is free; repeating these is not.

## `create_filter`

The operator describes a look. You turn it into numbers. That translation is the
whole job, and getting the scale wrong produces a filter that is created
successfully and looks broken — a failure that reports nothing, because as far
as every system involved is concerned it worked.

**The ranges are in the tool's schema. Read them there rather than guessing.**
They fall into three groups: some are 0–200 where **100 means unchanged**
(brightness, contrast, saturation), some are -100–100 where **0 means unchanged**
(temperature, exposure, shadows and most others), and blur is 0–10 in pixels.
Confusing the first two is the common mistake, and it is the one that produces a
grey or blown-out filter from a request for a subtle one.

**Only send what they asked to change.** An omitted adjustment keeps its neutral
value. Sending every field at neutral creates a filter that does nothing.

**Name it something they will recognise** in a list of filters — their words if
they named it, otherwise something descriptive. Never "Untitled".

**It is private unless they ask otherwise.** Do not set it public to be helpful.

**Report what came back, not what you sent.** The result carries what the Studio
actually stored. If it differs from your arguments, the stored version is the
truth.

Some looks cannot be built this way at all: `.cube` LUT imports and anything
needing an uploaded file are dashboard work. Say so rather than approximating a
LUT with adjustments and calling it the same thing.

## `duplicate_project`

**Resolve the name to an id first.** They will say "my Bandung booth", never an
id. Call `list_projects`, find it, confirm which one if more than one matches.
Duplicating the wrong booth is not dangerous, but it is a booth they now have to
delete.

**The copy is named by the Studio** — `<original>-copy`, then `-copy-1` and so
on. You do not choose the name and cannot pass one.

**It does not inherit the original's public address.** Nothing already published
or shared is disturbed by the copy, and the copy is not reachable at the
original's link. If they want the new booth public, that is a dashboard step.

**It copies settings, packages and promos — not sessions, media or money.** A
duplicate starts with no history. Say that if they seem to expect otherwise.

**There is no way to create a booth from nothing here.** If they want a brand new
booth rather than a copy, the connector will refuse, and the right answer is to
duplicate something close and edit it in the dashboard, or use the dashboard's
own new-booth flow.

## When something is refused

These calls can come back refused, and the message is written to be relayed.
Two are worth recognising:

**"This connection is read-only"** means the operator connected without granting
permission to create things. They need to reconnect and approve it. Say that;
do not retry.

**"This token cannot create things"** means the account was connected by the
older sign-in path, which is not allowed to write. Reconnecting through the
normal sign-in fixes it.

Either way, relay the sentence. Neither is a Dreambooth outage and neither is
worth retrying.
