import io, json, re, copy, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))
# Written next to this script, docs/submission/chatgpt-app-submission.json
# (gitignored), and, when it exists, copied to ~/Downloads for the portal
# upload. Override with CHATGPT_SUBMISSION_OUT.
OUT = os.environ.get("CHATGPT_SUBMISSION_OUT") or os.path.join(HERE, "chatgpt-app-submission.json")
SCHEMA_LOCAL = os.path.join(HERE, "chatgpt-app-submission.v1.json")
# What the importer checks, as far as three imports on 2026-08-23 reveal:
#   - /apps-sdk/ URL, 20 scanned tools          -> imported (the form then asked for exactly 5/3 cases)
#   - /apps-sdk/ URL, 22 tools (2 not scanned)  -> "must use $schema ..." (the importer's catch-all)
#   - /plugins/ URL (the schema's own const)    -> "must use $schema ..."
# So the importer wants the /apps-sdk/ URL literally - the one its message
# names and OpenAI's submission skill writes - even though the published
# schema's `const` says /plugins/ (it is a 301 target); and every tool and
# every tools_triggered name must be one the portal has already scanned. The
# same catch-all message covers both, which is what made this hard to see.
SCHEMA_URL = "https://developers.openai.com/apps-sdk/schemas/chatgpt-app-submission.v1.json"

def no_dash(s):
    return (s.replace(" \u2014 ", ", ").replace("\u2014", "-")
             .replace(" \ufffd ", ", ").replace("\ufffd", ",")
             .replace("\u2019", "'").replace("\u201c", '"').replace("\u201d", '"'))

# ------------------------------------------------------------------ app info
DESCRIPTION = """Dreambooth Studio runs self-service photobooths, the kind you find at weddings, events and malls. This app answers questions about them in chat.

Thinking of starting one? Ask what hardware you need, which cameras and printers work, how the plans are priced, what each print costs in paper and ribbon, or how payments and payouts work. Answers come from the Dreambooth documentation, and none of it needs an account.

Already running booths? Connect your account and ask how a booth did last weekend, what you earned this month and how much of it was cash, whether a booth is online right now, how many AI credits are left, or how much media a booth has produced. A sentence back, instead of opening the dashboard.

It can make four things for you: a photo filter you preview before it is created, a photo frame designed from a description and refined in conversation, a whole booth designed from a description, adjusted in conversation and created at its own link, and a copy of a booth you already run. Everything else it only reads. It cannot edit a booth that already exists, issue a refund, move money or delete anything, and it sees only the account you sign in with. Your booths, never another operator's.

When a figure leaves something out it says so. Cash and voucher income never reaches the wallet ledger, so income is reported from the sessions themselves rather than handed to you as a partial total."""

APP_INFO = {
    "display_name": "Dreambooth Studio",
    "subtitle": "Start and run a photobooth",          # 26 chars, limit 30
    "description": no_dash(DESCRIPTION),
    # The import enum has no ANALYTICS; PRODUCTIVITY is what the draft already
    # leads with (BUSINESS is the other honest fit).
    "category": "PRODUCTIVITY",
}

# ------------------------------------------------------------ annotations
# Mirrors src/mcp/server.ts: READ_ONLY / READ_ONLY_LOCAL / GRANTS_ACCESS /
# CREATES. All four hints are stated on every tool: the v2.0.0 review rejected
# the submission for hints that were absent rather than false, and a missing key
# reads as null in the portal. openWorldHint now follows the plugin guidelines'
# test (does it touch an external system, account or public platform?) rather
# than the MCP spec's "one known service is a closed world" reading, which is
# why it is true everywhere except the two tools that open no socket.
READ_ONLY       = {"readOnlyHint": True,  "destructiveHint": False, "idempotentHint": True,  "openWorldHint": True}
READ_ONLY_LOCAL = {"readOnlyHint": True,  "destructiveHint": False, "idempotentHint": True,  "openWorldHint": False}
GRANTS_ACCESS   = {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True}
CREATES         = {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True}

ANN = {
    "connect_account": GRANTS_ACCESS,
    "connection_status": READ_ONLY_LOCAL,
    "get_sessions": READ_ONLY,
    "get_gallery_stats": READ_ONLY,
    "search_docs": READ_ONLY,
    "list_projects": READ_ONLY,
    "get_project": READ_ONLY,
    "get_revenue_summary": READ_ONLY,
    "get_credits": READ_ONLY,
    "get_wallet_transactions": READ_ONLY,
    "create_filter": CREATES,
    "duplicate_project": CREATES,
    "start_frame": CREATES,
    "refine_frame": CREATES,
    "check_generation": READ_ONLY_LOCAL,
    "save_frame": CREATES,
    "preview_filter": READ_ONLY,
    "start_booth": CREATES,
    "refine_booth": CREATES,
    "create_booth": CREATES,
    "get_booth_draft": READ_ONLY,
    # Edits an uncreated draft: not read-only, not destructive, idempotent.
    "update_booth_draft": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True},
}

# ----------------------------------------------------------- justifications
# Portal field cap is 200 characters each. The twelve v1 tools keep the
# sentences the portal already holds, except where the export showed them
# truncated at exactly 200 or with mangled dashes - those are rewritten to fit.
J = {
  "connect_account": {
    "read_only_justification": "Not read-only, narrowly: it attaches an account to this conversation, which changes what it may see. It stores nothing in the account, edits nothing and deletes nothing.",
    "destructive_justification": "It grants access; it never removes or overwrites anything. Disconnecting afterwards leaves the account exactly as it was, and nothing it does can lose the operator's data.",
    "open_world_justification": "Open world: it starts a sign-in against Dreambooth Studio, a service outside ChatGPT, and the link it returns is approved by the person in their own browser, attaching that account here.",
  },
  "connection_status": {
    "read_only_justification": "Reads the credential state of the current request and returns it. It contacts no server at all, which is what makes it safe for the sign-in card to poll every two seconds.",
    "destructive_justification": "It only reports whether an account is attached and which one. It cannot change or clear that connection.",
    "open_world_justification": "Closed world, and checkably so: it reads the credential state of the request in hand and opens no socket at all. No external system, no account, nothing published.",
  },
  "get_sessions": {
    "read_only_justification": "Issues a single read of the operator's own session records. It cannot create, edit, refund or delete a session, and there is no write path to that data anywhere in this app.",
    "destructive_justification": "Reading a booking history changes nothing about it. The records it returns are the operator's own and remain untouched.",
    "open_world_justification": "Open world: it reads the operator's records on Dreambooth Studio, an external account. Scoped server-side to the token, and no tool here takes an email or user id, so it cannot be widened.",
  },
  "get_gallery_stats": {
    "read_only_justification": "Returns counts only, from a single read. It cannot delete media, extend retention, or alter what has expired.",
    "destructive_justification": "Counting photos does not touch them. Media that has expired past its retention window stays expired; this tool cannot restore or remove anything.",
    "open_world_justification": "Open world: it counts media held on Dreambooth Studio, an external account. It returns no media and no links to any, so nothing it hands back reaches further.",
  },
  "search_docs": {
    "read_only_justification": "Reads a public, build-time search index of our own documentation and returns short excerpts. It touches no account data at all, which is why it works before anyone signs in.",
    "destructive_justification": "It reads published documentation. There is nothing it could damage.",
    "open_world_justification": "Open world: it fetches a file from dreamboothstudio.com, a system outside ChatGPT. Not a web search though: it reads only our published docs index and cannot be pointed at another host.",
  },
  "list_projects": {
    "read_only_justification": "A single read of the booths the operator owns. It cannot create, rename, deactivate or delete a booth.",
    "destructive_justification": "Listing booths leaves every one of them exactly as it was.",
    "open_world_justification": "Open world: it lists booths held on Dreambooth Studio, an external account. The operator is resolved from the credential, never from an argument, so the model cannot widen what it reads.",
  },
  "get_project": {
    "read_only_justification": "Reads one booth's configuration and its device's current status. It cannot change a booth setting, restart a device, or alter any monitoring record.",
    "destructive_justification": "Checking whether a booth is online has no effect on the booth. The device is never contacted directly; this reads status our own service already holds.",
    "open_world_justification": "Open world: two endpoints on Dreambooth Studio, the booth record and its device status, both on the operator's external account. It reaches nothing beyond that service.",
  },
  "get_revenue_summary": {
    "read_only_justification": "Reads a revenue calculation the Studio dashboard already performs. It cannot move money, issue a refund, adjust a figure, or alter any transaction.",
    "destructive_justification": "It reports totals that already exist. Nothing about the underlying transactions changes when they are summed.",
    "open_world_justification": "Open world: it reads takings held on Dreambooth Studio, an external account. No payment provider is contacted and no money moves; the figures already exist there.",
  },
  "get_credits": {
    "read_only_justification": "Reads the current AI credit balance and subscription plan. It cannot purchase, grant, spend or refund credits, and it cannot change a plan.",
    "destructive_justification": "Checking a balance does not consume it. Credits are spent by running AI effects on a booth, which this app cannot do.",
    "open_world_justification": "Open world: it reads a balance held on Dreambooth Studio, an external account. No billing provider is contacted and nothing is bought.",
  },
  "get_wallet_transactions": {
    "read_only_justification": "Reads the operator's own wallet ledger. It cannot initiate a withdrawal, move funds, reverse an entry, or modify the ledger in any way.",
    "destructive_justification": "Reading a ledger is what a ledger is for. Every entry it returns stays exactly as recorded.",
    "open_world_justification": "Open world: it reads a ledger held on Dreambooth Studio, an external account. No bank or disbursement provider is contacted and no funds move.",
  },
  "create_filter": {
    "read_only_justification": "It creates one new photo filter on the operator's own account: a name and numeric adjustments. It only ever adds a row; it cannot modify or remove an existing filter, and no tool here can.",
    "destructive_justification": "It adds; it never overwrites or deletes. It cannot rename, replace, deactivate or remove an existing filter, and it cannot touch photos, bookings or money. Undoing it is one click in the dashboard.",
    "open_world_justification": "Open world: it writes a filter to the operator's account on Dreambooth Studio, an external service. Operator resolved from the token; the schema has no userId or email field.",
  },
  "duplicate_project": {
    "read_only_justification": "It creates a copy of a booth the operator already owns, from an id they supply. The original is unchanged. It adds a new booth and nothing else.",
    "destructive_justification": "It only adds. It cannot edit, rename, deactivate or delete the original or any other booth. The copy gets its own link name, so nothing published changes; undoing it is one click in the dashboard.",
    "open_world_justification": "Open world: it creates a booth on Dreambooth Studio, reachable at its own public link. The source is looked up under the token's operator, so another account's booth cannot be copied.",
  },
  "start_frame": {
    "read_only_justification": "Not read-only: it opens a design thread and makes one AI image on the operator's own account. It adds a draft generation; it edits, replaces or removes nothing, and saves no frame.",
    "destructive_justification": "It only adds a preview inside a thread. It cannot overwrite, rename or delete a frame, a thread or anything else; nothing is in the frame list until save_frame.",
    "open_world_justification": "Open world: it opens a design thread and runs an image generation on the operator's Dreambooth account, an external service. Operator resolved from the token; no userId or email argument.",
  },
  "refine_frame": {
    "read_only_justification": "Not read-only: it adds one more AI generation to a design thread the operator owns. It changes no saved frame and nothing outside that thread.",
    "destructive_justification": "Only adds a new version; earlier versions stay in the thread and remain saveable. It cannot delete, overwrite or deactivate anything.",
    "open_world_justification": "Open world: it adds a generation to a thread on the operator's Dreambooth account, an external service. The thread must belong to the token's operator; no userId or email argument.",
  },
  "check_generation": {
    "read_only_justification": "Reads the state of a background job held in this server's memory. It never calls Dreambooth and never writes anything.",
    "destructive_justification": "A status read. Asking it any number of times creates, edits or removes nothing; it only reports what a start/refine/create job has done so far.",
    "open_world_justification": "Closed world: no outbound call at all. It reads a job record in this server's own memory, keyed to a hash of the caller's token, so it cannot even see another connection's jobs.",
  },
  "save_frame": {
    "read_only_justification": "Not read-only: it turns one chosen generation into a new frame on the operator's account. It only ever adds a frame; it edits, replaces or removes none.",
    "destructive_justification": "Adds one frame. It cannot overwrite, rename, deactivate or delete an existing frame or assign one to a booth. Saving twice makes two frames, which idempotentHint states.",
    "open_world_justification": "Open world: it saves a frame to the operator's account on Dreambooth Studio, an external service. Thread and generation are looked up under the token's operator; no userId argument.",
  },
  "preview_filter": {
    "read_only_justification": "Read-only: it asks Dreambooth to render its sample photo through the filter pipeline and returns an image URL. No filter is written and nothing on the account changes.",
    "destructive_justification": "Renders a preview image; creates, edits or removes nothing the operator can see. The same look renders to the same cached file however often it is asked.",
    "open_world_justification": "Open world: it asks Dreambooth Studio, an external service, to render its sample photo and returns the image URL. Session resolved from the token; no userId or email argument.",
  },
  "start_booth": {
    "read_only_justification": "Not read-only: it asks Dreambooth to design a booth draft (spec, welcome screens, background) on the operator's own account. It adds a draft; it edits nothing and creates no booth.",
    "destructive_justification": "It only adds a draft that expires in 7 days. It cannot overwrite, deactivate or delete an existing booth or draft; nothing is in the booth list until create_booth.",
    "open_world_justification": "Open world: it has Dreambooth Studio, an external service, design a draft on the operator's account. Same route the /new wizard uses; operator resolved from the token, no userId argument.",
  },
  "refine_booth": {
    "read_only_justification": "Not read-only: it redraws part of a draft the operator owns, or rebuilds it from a new description. It changes only that uncreated draft, never a created booth.",
    "destructive_justification": "A redraw replaces an image inside a draft the operator asked to change; it cannot touch any booth that exists, and the Studio caps a draft at 5 redraws and 3 rebuilds.",
    "open_world_justification": "Open world: it redraws part of a draft on the operator's Dreambooth account, an external service. The draft must belong to the token's operator; no userId or email argument.",
  },
  "get_booth_draft": {
    "read_only_justification": "Reads one booth draft (a design not yet created) on the operator's own account and returns it. It writes nothing and creates nothing.",
    "destructive_justification": "A read of a draft: asking it any number of times changes nothing. It cannot delete, overwrite or create a draft or a booth.",
    "open_world_justification": "Open world: it reads a draft held on the operator's Dreambooth account, an external service. The draft must belong to the token's operator; no userId or email argument.",
  },
  "update_booth_draft": {
    "read_only_justification": "Not read-only: it changes settings of a booth DRAFT the operator owns (title, button text, colours, photo count, frames, filters) before it is created. A created booth is never touched.",
    "destructive_justification": "It edits a draft that is not yet a booth; nothing published is overwritten or deleted, and a draft expires in 7 days anyway. The same edit twice leaves the same draft (idempotent).",
    "open_world_justification": "Open world: it edits a draft on the operator's Dreambooth account, an external service. Nothing is published by it; the draft must belong to the token's operator, no userId argument.",
  },
  "create_booth": {
    "read_only_justification": "Not read-only: it creates one booth from a draft the operator approved, with its frames and filters. It adds; it cannot edit or delete a booth that exists.",
    "destructive_justification": "Only adds: one booth, its own frames, picked filters. It cannot overwrite, deactivate or delete a booth; a taken link name stops it before anything is made. Creating twice makes two.",
    "open_world_justification": "Open world, and the clearest case for it here: it creates a booth that is publicly visible at dreambooth.app, on the operator's external account. Operator resolved from the token.",
  },
}

# ---------------------------------------------------------------- test cases
# tools_triggered = exact MCP action names only (the reviewer routes on these);
# ordering lives in expected_output. Ordered by importance in case the form
# caps the list: the first five positives / three negatives stand on their own.
POSITIVE = [
  {
    "description": "Get troubleshooting help without an account",
    "user_prompt": "My printer stopped responding mid-session, what do I do?",
    "tools_triggered": "search_docs",
    "expected_output": "Troubleshooting steps drawn from Dreambooth's own documentation, returned with no account connected. This is the case that verifies product, pricing and hardware questions answer before sign-in.",
  },
  {
    "description": "Review monthly revenue by payment channel",
    "user_prompt": "What was my revenue last month, split by payment channel?",
    "tools_triggered": "get_revenue_summary",
    "expected_output": "A monthly total with gateway, cash voucher and discount voucher separated. AI-effect revenue is reported as its own figure, not folded into the headline total. If the account takes money in more than one currency, each is reported separately: there is no exchange rate in this data, so a combined figure would be invented.",
  },
  {
    "description": "Preview a photo filter, then create it",
    "user_prompt": "Make me a filter that looks warm and slightly faded, show me first",
    "tools_triggered": "preview_filter, create_filter",
    "expected_output": "preview_filter runs first: a card with the sample photo rendered through the filter appears BEFORE anything is created, and the answer names any adjustments the preview cannot show. create_filter runs only after the operator approves, with the same adjustments, and its card shows the created filter on the sample photo. Calling create_filter twice makes two filters: the tool declares itself non-idempotent, so a client should not retry it automatically.",
  },
  {
    "description": "Design a photo frame in conversation",
    "user_prompt": "Design me a photo strip frame with batik motifs in warm gold",
    "tools_triggered": "start_frame, check_generation, refine_frame, save_frame",
    "expected_output": "start_frame returns a job id and says nothing exists yet; a card shows the frame being generated and turns into the preview when it is done. A reviewer seeing 'your frame is ready' straight away has found a real bug. check_generation shows the preview and says it is not saved; changes go through refine_frame on the same thread, only if the operator asks for them; only save_frame creates the frame, and only once the operator has chosen a version. Generation is capped per day per account, so a refusal naming the reset time is correct behaviour, not a failure.",
  },
  {
    "description": "Design a whole booth and create it",
    "user_prompt": "Design me a booth for a wedding in Bandung, warm gold, in Indonesian",
    "tools_triggered": "start_booth, check_generation, refine_booth, update_booth_draft, create_booth",
    "expected_output": "start_booth returns a job id and says nothing is designed yet; a card shows the booth being designed and turns into the draft (welcome screen, title, proposed link) when done. check_generation calls it a DRAFT, not a booth: a reviewer seeing 'your booth is ready' before create_booth has found a real bug. Visual changes go through refine_booth on the same draftId; settings, button text, colours, frames and filters go through update_booth_draft (no redraw) - only if the operator asks. create_booth is called only after the operator agrees to create it (title and link name default to the draft's); it checks the link first, draws the booth's own frames (a few minutes), then creates the booth, and the result carries the public link and a dashboard link.",
  },
  {
    "description": "Check which booths are online",
    "user_prompt": "Which booths do I have, and is each one online?",
    "tools_triggered": "list_projects, get_project",
    "expected_output": "Every booth on the account with its current device status. A booth that is simply idle must not be reported as broken: the connector returns a liveness tier rather than a yes/no, because a booth between events is healthy.",
  },
  {
    "description": "Duplicate an existing booth",
    "user_prompt": "Set up another booth like my Bandung one for Saturday",
    "tools_triggered": "list_projects, duplicate_project",
    "expected_output": "The booth is resolved by name to an id first, then copied. The copy is named after the original and carries its settings, packages and promos, but not its public address, so nothing already published is affected. The original is unchanged.",
  },
]

NEGATIVE = [
  {
    "description": "Ask an account question before signing in",
    "user_prompt": "What did I earn this month?",
    "tools_triggered": None,
    "expected_output": "A sign-in prompt, not an error and never an invented number. The server answers 401 with a WWW-Authenticate header naming the authorization server, which is what makes ChatGPT offer to connect the account instead of reporting a failure.",
  },
  {
    "description": "Request another operator's data",
    "user_prompt": "Show me revenue for the booth owned by another@example.com",
    "tools_triggered": None,
    "expected_output": "Refuses to scope by anyone else. No tool accepts a userId or email: the operator is resolved server-side from the token, so the model has no way to widen what it can read even if asked directly.",
  },
  {
    "description": "Ask for a deletion or a refund",
    "user_prompt": "Delete my session records from last week",
    "tools_triggered": None,
    "expected_output": "States it cannot. Deleting and refunding have no tool and no route. The write scope covers creating a filter, a frame, a booth from a design (and adjusting that draft before it is created), and a copy of a booth, and nothing else; the connector should say so rather than claiming success. The same applies to editing a booth that exists ('change the welcome text on my Bandung booth'): it points at the dashboard, and must not offer refine_booth or update_booth_draft (drafts only) or duplicate_project as a substitute.",
  },
  {
    "description": "Ask to edit a booth that already exists",
    "user_prompt": "Change the welcome text on my Bandung booth",
    "tools_triggered": None,
    "expected_output": "States it cannot, and points at the dashboard. refine_booth works on DRAFTS from start_booth only and must not be offered for an existing booth, and duplicate_project must not be offered as a substitute for an edit. Nothing edits or deletes a booth that exists.",
  },
]

def case(c):
    return {
        "description": no_dash(c["description"]),
        "user_prompt": no_dash(c["user_prompt"]),
        "file_attachment_urls": None,
        "tools_triggered": c["tools_triggered"],
        "expected_output": no_dash(c["expected_output"]),
        "expected_output_url": None,
    }

# ------------------------------------------------------------------ assemble
# Tools the portal has not scanned yet can be left out for an interim import:
#   CHATGPT_SUBMISSION_EXCLUDE="get_booth_draft,update_booth_draft" python build_submission_import.py
EXCLUDE = {t.strip() for t in os.environ.get("CHATGPT_SUBMISSION_EXCLUDE", "").split(",") if t.strip()}
for t in EXCLUDE:
    assert t in ANN, f"CHATGPT_SUBMISSION_EXCLUDE names an unknown tool: {t}"
    del ANN[t]
    del J[t]
def without_excluded(tools_triggered):
    kept = [t for t in re.split(r",\s*", tools_triggered) if t not in EXCLUDE]
    return ", ".join(kept)
for c in POSITIVE:
    c["tools_triggered"] = without_excluded(c["tools_triggered"])
if "update_booth_draft" in EXCLUDE:
    # The copy must describe what the portal can see today.
    APP_INFO["description"] = APP_INFO["description"].replace(
        "a whole booth designed from a description, adjusted in conversation and created at its own link",
        "a whole booth designed from a description and created at its own link",
    ).replace("It cannot edit a booth that already exists,", "It cannot edit a booth,")
    for c in NEGATIVE:
        c["expected_output"] = c["expected_output"].replace(
            "a booth from a design (and adjusting that draft before it is created), and a copy of a booth",
            "a booth from a design, and a copy of a booth",
        ).replace("must not offer refine_booth or update_booth_draft (drafts only)", "must not offer refine_booth (drafts only)")
    for c in POSITIVE:
        c["expected_output"] = c["expected_output"].replace(
            "Visual changes go through refine_booth on the same draftId; settings, button text, colours, frames and filters go through update_booth_draft (no redraw) - only if the operator asks.",
            "Changes go through refine_booth on the same draftId, only if the operator asks.",
        )
tools = {}
for name in ANN:
    assert name in J, f"no justifications for {name}"
    js = {k: no_dash(v) for k, v in J[name].items()}
    for field, text in js.items():
        assert len(text) <= 200, f"{name}.{field} is {len(text)} chars (portal cap 200)"
        assert text.strip() and "\ufffd" not in text
    tools[name] = {"annotations": dict(ANN[name]), "justifications": js}
assert set(J) == set(ANN), set(J) ^ set(ANN)

doc = {
    "$schema": SCHEMA_URL,
    "schema_version": 1,
    "app_info": APP_INFO,
    "tools": tools,
    # The portal's importer wants EXACTLY five and three ("test_cases must
    # include exactly 5 entries"); the schema's minItems understates it. The
    # lists above are ordered so the head is the submission and the tail
    # (booths online, duplicate, edit-existing) are alternates kept in the
    # checklist for swapping in by hand.
    "test_cases": [case(c) for c in POSITIVE[:5]],
    "negative_test_cases": [case(c) for c in NEGATIVE[:3]],
}

# ---------------------------------------------------------- self-validation
schema = json.load(io.open(SCHEMA_LOCAL, encoding="utf-8"))
problems = []
def req(obj, keys, where):
    for k in keys:
        if k not in obj: problems.append(f"{where}: missing {k}")
req(doc, schema["required"], "root")
if doc["$schema"] != SCHEMA_URL:
    problems.append("$schema value")
if doc["schema_version"] != 1: problems.append("schema_version must be 1")
ai = doc["app_info"]
if not re.search(r"\S", ai["display_name"]): problems.append("display_name empty")
if len(ai["subtitle"]) > 30 or not re.search(r"\S", ai["subtitle"]): problems.append("subtitle >30 or empty")
if len(ai["description"]) > 4000 or not re.search(r"\S", ai["description"]): problems.append("description >4000 or empty")
if ai["category"] not in schema["$defs"]["appInfo"]["properties"]["category"]["enum"]: problems.append("category not in enum")
for name, t in doc["tools"].items():
    req(t, ["annotations", "justifications"], f"tools.{name}")
    req(t["annotations"], ["readOnlyHint", "openWorldHint", "destructiveHint"], f"tools.{name}.annotations")
    for k in ("readOnlyHint", "openWorldHint", "destructiveHint"):
        if not isinstance(t["annotations"].get(k), bool): problems.append(f"tools.{name}.annotations.{k} not boolean")
    req(t["justifications"], ["read_only_justification", "open_world_justification", "destructive_justification"], f"tools.{name}.justifications")
    for k, v in t["justifications"].items():
        if not (isinstance(v, str) and re.search(r"\S", v)): problems.append(f"tools.{name}.justifications.{k} empty")
if len(doc["test_cases"]) != 5: problems.append("test_cases must be exactly 5 (portal importer)")
if len(doc["negative_test_cases"]) != 3: problems.append("negative_test_cases must be exactly 3 (portal importer)")
for i, c in enumerate(doc["test_cases"]):
    req(c, ["description", "user_prompt", "tools_triggered"], f"test_cases[{i}]")
    if len(c["description"]) > 4000: problems.append(f"test_cases[{i}].description >4000")
    for k in ("description", "user_prompt", "tools_triggered"):
        if not (isinstance(c.get(k), str) and re.search(r"\S", c[k])): problems.append(f"test_cases[{i}].{k} empty")
    for t in re.split(r",\s*", c["tools_triggered"]):
        if t not in doc["tools"]: problems.append(f"test_cases[{i}] names unknown tool {t!r}")
for i, c in enumerate(doc["negative_test_cases"]):
    req(c, ["description", "user_prompt"], f"negative_test_cases[{i}]")
    for k in ("description", "user_prompt"):
        if not (isinstance(c.get(k), str) and re.search(r"\S", c[k])): problems.append(f"negative_test_cases[{i}].{k} empty")
    if not (c["tools_triggered"] is None or isinstance(c["tools_triggered"], str)): problems.append(f"negative_test_cases[{i}].tools_triggered type")

# Full JSON-Schema validation when the library is present. The published schema
# pins `$schema` to the /plugins/ URL (its own $id) while the portal asks for
# the /apps-sdk/ one, so validate against a copy that accepts both.
try:
    import jsonschema
    sch = copy.deepcopy(schema)
    # The published const names the /plugins/ URL; the importer wants /apps-sdk/.
    sch["properties"]["$schema"] = {"enum": [SCHEMA_URL, schema["properties"]["$schema"]["const"]]}
    jsonschema.Draft202012Validator.check_schema(sch)
    errs = sorted(jsonschema.Draft202012Validator(sch).iter_errors(doc), key=lambda e: list(e.path))
    for e in errs: problems.append("jsonschema: " + "/".join(map(str, e.path)) + ": " + e.message)
    print("jsonschema:", "ok" if not errs else f"{len(errs)} error(s)")
except ImportError:
    print("jsonschema library not installed; structural checks only")

if problems:
    print("PROBLEMS:"); [print(" -", p) for p in problems]; sys.exit(1)

with io.open(OUT, "w", encoding="utf-8", newline="\n") as f:
    json.dump(doc, f, indent=2, ensure_ascii=False)
    f.write("\n")
print("wrote", OUT)
dl = os.path.join(os.path.expanduser("~"), "Downloads")
if os.path.isdir(dl) and os.path.abspath(os.path.dirname(OUT)) != os.path.abspath(dl):
    import shutil
    shutil.copy(OUT, os.path.join(dl, "chatgpt-app-submission.json"))
    print("copied to", os.path.join(dl, "chatgpt-app-submission.json"))
print(f"tools: {len(tools)} | positive: {len(doc['test_cases'])} | negative: {len(doc['negative_test_cases'])}")
print(f"subtitle {len(ai['subtitle'])} chars | description {len(ai['description'])} chars")
longest = max(((n, f, len(v)) for n, t in tools.items() for f, v in t['justifications'].items()), key=lambda x: x[2])
print("longest justification:", longest)
