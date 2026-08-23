---
name: creating-filters-and-booths
description: Make things on an operator's Dreambooth account from a conversation — a photo filter previewed before it is created, a photo frame designed and refined with the image model, a whole booth designed from a description, adjusted (settings, button text, frames, filters) and created at its own link, or a copy of a booth they already run. Use for "make me a filter that looks…", "design me a frame with…", "design a booth for…", "make it 4 photos", "set up another booth like my Bandung one". Read this before creating anything: these are the only tools here that change an account, nothing here edits or deletes what already exists, and a create called twice makes two of the thing.
---

# Making things on an operator's account

Everything in this connector reads, except the tools below. They are the only
calls that leave an account different from how they found it, none of them can
be reversed from this conversation, and none of them touches a booth, frame or
filter that already exists — editing and deleting are dashboard work, always.

| They ask for | Tools, in order |
|---|---|
| A photo filter from a described look | `preview_filter` (free, shows it) → `create_filter` |
| A photo frame from a description | `start_frame` → `check_generation` → `refine_frame` (if asked) → `save_frame` |
| A whole new booth | `start_booth` → `check_generation` → `refine_booth` / `update_booth_draft` (if asked) → `create_booth` |
| Another booth like one they run | `list_projects` → `duplicate_project` |

`get_booth_draft` reads a booth draft back by id when the conversation has moved
on; `check_generation` reports every background job. Neither creates anything.

## Before you call any of them

**Say what you are about to make, in their words, and let them answer.** The
host shows its own approval dialog, but that dialog shows arguments, not intent
— "contrast 112, saturation 88" is not something an operator can check. A
sentence they can agree or object to is: *"A filter called Senja Hangat — warmer,
slightly faded, a little less contrast. Make it?"*

**Nothing here edits or deletes what exists.** There is no tool that changes an
existing filter, frame or booth, and the connector cannot PUT or DELETE
anything. A booth *draft* can be changed before it is created (below); a booth
that exists cannot. If they want to adjust or remove something that exists,
send them to the dashboard. Do not offer a duplicate as a way to "edit".

**Creating twice makes two.** `create_filter`, `save_frame`, `create_booth` and
`duplicate_project` are non-idempotent and say so in their annotations. If a
create times out, do NOT repeat it — the write may have succeeded and only the
reply went missing. Tell them to check their dashboard first. Repeating a read,
a preview, a check or a draft edit is free; repeating a create is not.

**Nothing "exists" until the tool that makes it says so.** Previews, drafts and
running jobs are not things the operator has. Never describe a frame as saved or
a booth as created before `save_frame` / `create_booth` has finished and
`check_generation` says `done`.

## Filters — `preview_filter`, then `create_filter`

The operator describes a look. You turn it into numbers. That translation is the
whole job, and getting the scale wrong produces a filter that is created
successfully and looks broken — a failure that reports nothing, because as far
as every system involved is concerned it worked.

**Preview first, always.** `preview_filter` renders the Studio's sample photo
through the adjustments and shows it in the chat, for free, and names the
adjustments a still preview cannot show (shadows, highlights and the like — the
booth still applies them). Show it, let them react, then create with the same
adjustments.

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

## Frames — `start_frame` → `check_generation` → `refine_frame` → `save_frame`

A frame is designed the way the Studio's Frame Studio does it: a thread with
the image model, one version at a time.

**`start_frame` returns a job id, not a frame.** Say that generating takes about
a minute, then poll `check_generation` (every 15 seconds or so). When it says
`done` it carries a preview image, a `threadId` and a `generationId` — a
preview, not a saved frame. Show it.

**Changes go through `refine_frame` on the same thread**, one instruction at a
time ("warmer", "thicker border", "fewer motifs"), and only when the operator
asks — never iterate on your own. Earlier versions stay in the thread and can
still be saved.

**`save_frame` is the only step that creates a frame**, from one chosen
`generationId`, once the operator has picked a version. Saving twice makes two
frames.

**Generation is capped per account per day.** A refusal naming when it resets
is correct behaviour, not a failure; relay it.

## Booths — `start_booth` → `check_generation` → `refine_booth` / `update_booth_draft` → `create_booth`

A booth is designed the way dreambooth.app/new does it: a DRAFT first (title,
colours, welcome screens, in-booth background), argued with in conversation,
then created.

**Gather first, then start.** There is no questions step: before `start_booth`,
ask what /new would ask — the occasion or business, the vibe and colours, and
the language the booth should speak — and put all of it in the prompt. Each
`start_booth` is a new draft and spends one of its three full generations, so do
not call it speculatively or twice for one request.

**`start_booth` returns a job id, not a booth.** Say designing takes one to three
minutes; poll `check_generation`. When it says `done` it carries `draft{…}` —
title, headline, button text, palette, proposed link name, a welcome preview —
and the card in the chat shows it. A draft is not a booth. Do not say "your
booth is ready".

**Two ways to change a draft, and they are different:**

- **`refine_booth` redraws** — the welcome screen (phone, laptop or both), the
  in-booth background, or the whole draft from a new description. This is for
  what is *painted*: the headline and subtext of a designed welcome are part of
  the image, so "change the headline" is a redraw. Redraws are limited (five
  per draft, three full rebuilds); `check_generation` reports what is left.
- **`update_booth_draft` sets, without a redraw** — the title, the link name,
  the welcome button text, the colours, capture mode, the booth's language,
  which frames and filters it carries, its AI effect, and the page settings the
  dashboard editor offers: number of photos, countdown, timeouts, GIF and
  recording, retake, checkout, payment, result. It answers at once with the
  draft, `applied` and `rejected`. **Relay a rejection as a sentence** ("the
  headline on this draft is painted into the image — shall I redraw it?"), never
  as success. Prices and packages are dashboard work; it will say so.

**`create_booth` is the only step that makes a booth**, and it makes a complete
one: it reads the draft (so everything `update_booth_draft` set is carried),
checks the link name, draws the booth's own three frames, adds starter frames
and the Studio's default filter the way /new does, then creates the booth. The
title and link name default to the draft's — confirm them with the operator
before calling, and say it takes **two to six minutes**. Filters made with
`create_filter` and frames saved with `save_frame` in this conversation are
carried automatically. If the link name is taken it stops before drawing
anything — ask for another and call again. When `check_generation` says `done`
the result carries the booth's public link and a dashboard link; the booth is
live (unlisted) at once. After that, it is a booth that exists: changes happen
in the dashboard, not here.

**If the conversation lost the draft**, `get_booth_draft` reads it back by
`draftId` (drafts live seven days); `start_booth` again only when the operator
wants a different booth.

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

**A copy is not an edit.** If they want a *different* booth rather than a copy,
design one with `start_booth`; if they want to change one that exists, that is
the dashboard.

## When something is refused

These calls can come back refused, and the message is written to be relayed.

**"This connection is read-only"** means the operator connected without granting
permission to create things. They need to reconnect and approve it. Say that;
do not retry.

**"This token cannot create things"** means the account was connected by the
older sign-in path, which is not allowed to write. Reconnecting through the
normal sign-in fixes it.

**A used-up allowance** (daily frame generations, a draft's redraws or full
generations, booth drafts per hour) names what remains possible. Relay that.

**"Booth generation is not enabled on this Dreambooth"** means the feature is
off server-side; nothing was generated. Offer the dashboard's own flow.

Either way, relay the sentence. None of these is a Dreambooth outage and none is
worth retrying.
