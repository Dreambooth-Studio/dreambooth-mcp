"""Build the plugin ZIP the ChatGPT plugin portal's "Upload new version" takes.

The portal moved from an import form to plugin packages (2026-09): a ZIP with
`plugin.json` (listing, review test cases, release notes), `mcp.json` (the one
remote MCP server), `skills/` and `assets/`. Tool annotations and their
justifications are no longer part of the submission; the portal scans them from
the live server. Spec: https://developers.openai.com/plugins/build/plugins and
https://developers.openai.com/plugins/deploy/submission

    python docs/submission/build_plugin_zip.py [--demo-url URL] [--folder]

Listing copy and test cases come from build_submission_import.py, so the two
cannot drift. Writes dist-plugin/ (gitignored) and copies the ZIP to
~/Downloads. Reviewer credentials never go in the package: the portal rejects
`test_credentials` and `reviewer_instructions`, and they are entered in
Review details instead.
"""
import argparse, glob, io, json, os, re, runpy, shutil, struct, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

listing = runpy.run_path(os.path.join(HERE, "build_submission_import.py"), run_name="listing")
doc, no_dash = listing["doc"], listing["no_dash"]

# The plugin identity the portal already holds for Dreambooth Studio, minted
# when it was created through the old submission form. The upload refuses any
# other value: "Plugin name must match the existing plugin". The listing's
# public slug is a separate thing and stays dreambooth-studio.
NAME = "app-6a7afe588ab08191833eda9ff7fd59a1"
# What the ZIP and its staging folder are called on disk.
FILE_STEM = "dreambooth-studio"
# Above both the 1.0.0 the new portal shows and the v2.0.0 the old form took.
# Bump for every upload: each one is its own package version.
VERSION = "2.1.2"
# One of the portal's fixed list: Productivity, Creativity, Developer Tools,
# Business & Operations, Data & Analytics, Communication, Education &
# Research, Security, Finance, Healthcare, Travel, Entertainment, Other.
# "Productivity" could not be confirmed against the listing (2026-10-07);
# operators running a photobooth business is Business & Operations.
CATEGORY = "Business & Operations"
# The server the portal has connected. Changing it needs OpenAI support.
MCP_SERVER = "dreambooth"
MCP_URL = "https://mcp.dreamboothstudio.com/mcp"

# docs/chatgpt-listing.md §2. Check all four answer 200 before submitting.
URLS = {
    "websiteURL": "https://dreamboothstudio.com",
    "supportURL": "https://dreamboothstudio.com/en/docs/getting-started/contact-support",
    "privacyPolicyURL": "https://dreamboothstudio.com/en/privacy",
    "termsOfServiceURL": "https://dreamboothstudio.com/en/terms",
}

# docs/chatgpt-listing.md §3, the real briefs the screenshots were rendered from.
STARTER_PROMPTS = [
    "Design me a photobooth for a garden wedding in Bandung, warm gold with soft florals",
    "Design a photo strip frame with warm gold batik motifs and generous margins",
    "Make me a warm, slightly faded filter, and show me before you create it",
]

CAPABILITIES = [
    "Answer product, hardware and setup questions",
    "Read booth sessions, revenue, credits and device status",
    "Create filters, frames and booths, and copy a booth",
]

RELEASE_NOTES = (
    "Booth design is back (start_booth, refine_booth, get_booth_draft, update_booth_draft, "
    "create_booth), run end to end against production first. Every connection sees the same "
    "22 tools, signed in or not, and a generation job survives a token refresh. refine_booth "
    "and update_booth_draft are now marked destructive, because they overwrite a draft. "
    "connect_account says which of its three answers it gave, and that its sign-in link is "
    "Google only. Packaged as a plugin with five skills."
)

COMMERCE_DESCRIPTION = (
    "Nothing is sold or paid for inside ChatGPT. Booth guests pay on the booth itself, "
    "outside this plugin, and no tool here moves money."
)

ap = argparse.ArgumentParser()
ap.add_argument("--demo-url", help="reviewer-accessible video walkthrough; required before submitting for review")
ap.add_argument("--folder", action="store_true", help="wrap the files in a top-level dreambooth-studio/ folder")
args = ap.parse_args()

problems = []

# ------------------------------------------------------------------ staging
DIST = os.path.join(ROOT, "dist-plugin")
STAGE = os.path.join(DIST, FILE_STEM)
shutil.rmtree(DIST, ignore_errors=True)
os.makedirs(os.path.join(STAGE, "assets"))

def write_text(rel, text):
    path = os.path.join(STAGE, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # LF everywhere: a Windows checkout hands SKILL.md over with CRLF, and the
    # frontmatter is parsed on the other side.
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text.replace("\r\n", "\n"))

# Skills: chatgpt-skills/<name>/ becomes skills/<name>/, every file in it.
skill_names = []
for skill_dir in sorted(glob.glob(os.path.join(ROOT, "chatgpt-skills", "*", ""))):
    skill = os.path.basename(os.path.dirname(skill_dir))
    md = os.path.join(skill_dir, "SKILL.md")
    if not os.path.isfile(md):
        continue
    for src in glob.glob(os.path.join(skill_dir, "**", "*"), recursive=True):
        if os.path.isdir(src) or src.endswith(".zip"):
            continue
        rel = os.path.join("skills", skill, os.path.relpath(src, skill_dir))
        if src.endswith((".md", ".txt", ".json")):
            write_text(rel, io.open(src, encoding="utf-8").read())
        else:
            os.makedirs(os.path.dirname(os.path.join(STAGE, rel)), exist_ok=True)
            shutil.copy(src, os.path.join(STAGE, rel))
    text = io.open(md, encoding="utf-8").read().replace("\r\n", "\n")
    fm = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not fm:
        problems.append(f"skills/{skill}/SKILL.md has no YAML frontmatter")
    else:
        fields = dict(re.findall(r"^(name|description):\s*(.+)$", fm.group(1), re.M))
        if fields.get("name", "").strip() != skill:
            problems.append(f"skills/{skill}: frontmatter name {fields.get('name')!r} differs from its folder")
        if not fields.get("description", "").strip():
            problems.append(f"skills/{skill}: frontmatter has no description")
    skill_names.append(skill)

# Assets: the ring mark from src/ui/shell.ts as a 48-unit SVG, and the
# portal screenshots when they have been rendered (they are build output).
shutil.copy(os.path.join(HERE, "plugin-assets", "logo.svg"), os.path.join(STAGE, "assets", "logo.svg"))
screenshots = []
for png in sorted(glob.glob(os.path.join(HERE, ".screenshots", "portal", "*.png"))):
    rel = "assets/screenshot-" + os.path.basename(png)
    shutil.copy(png, os.path.join(STAGE, rel))
    screenshots.append("./" + rel)

write_text("mcp.json", json.dumps({
    "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    "mcpServers": {MCP_SERVER: {"type": "streamable-http", "url": MCP_URL}},
}, indent=2) + "\n")

# ------------------------------------------------------------------ manifest
app = doc["app_info"]

def positive(c):
    return {
        "description": c["description"],
        "prompt": c["user_prompt"],
        "tools_triggered": c["tools_triggered"],
        "expected_behavior": c["expected_output"],
    }

def negative(c):
    return {
        "description": c["description"],
        "prompt": c["user_prompt"],
        "expected_behavior": c["expected_output"],
    }

review = {
    "test_cases": {
        "positive": [positive(c) for c in doc["test_cases"]],
        "negative": [negative(c) for c in doc["negative_test_cases"]],
    },
    "commerce": False,
    "commerce_description": COMMERCE_DESCRIPTION,
}
# Omitted rather than empty when not given: omission keeps whatever the
# dashboard already holds, an empty string would clear it.
if args.demo_url:
    review["demo_recording_url"] = args.demo_url

manifest = {
    "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    "name": NAME,
    "version": VERSION,
    "description": "Answer questions about running Dreambooth photobooths, review your booths' sessions and revenue, and design filters, frames and booths in conversation.",
    "author": {"name": "Dreambooth", "email": "support@dreamboothstudio.com", "url": "https://dreamboothstudio.com"},
    "homepage": "https://dreamboothstudio.com",
    "repository": "https://github.com/Dreambooth-Studio/dreambooth-mcp",
    "keywords": ["photobooth", "events", "booth management", "photo filters", "photo frames"],
    "extensions": {
        "com.openai": {
            "interface": {
                "displayName": app["display_name"],
                "shortDescription": app["subtitle"],
                "longDescription": app["description"],
                "developerName": "Dreambooth",
                "category": CATEGORY,
                "capabilities": CAPABILITIES,
                **URLS,
                "defaultPrompt": STARTER_PROMPTS,
                "composerIcon": "./assets/logo.svg",
                "logo": "./assets/logo.svg",
                **({"screenshots": screenshots} if screenshots else {}),
            },
            "onboardingSkill": "./skills/getting-started/SKILL.md",
            "review": review,
            "publication": {"release_notes": no_dash(RELEASE_NOTES)},
        }
    },
}
write_text("plugin.json", json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")

# ---------------------------------------------------------------- validation
# The submission limits from the field reference, checked here because an
# upload accepts longer draft text and only fails at submit time.
ui = manifest["extensions"]["com.openai"]["interface"]
for field, limit in (("displayName", 30), ("shortDescription", 30), ("longDescription", 4000), ("developerName", 80)):
    if not ui[field].strip() or len(ui[field]) > limit:
        problems.append(f"interface.{field} is {len(ui[field])} chars (limit {limit})")
if len(manifest["description"]) > 4000:
    problems.append("description over 4000 chars")
if len(STARTER_PROMPTS) > 3 or len(set(STARTER_PROMPTS)) != len(STARTER_PROMPTS):
    problems.append("defaultPrompt: at most three, all different")
for p in STARTER_PROMPTS:
    if len(p) > 128 or "@" in p:
        problems.append(f"defaultPrompt over 128 chars or with an @mention: {p!r}")
if len(CAPABILITIES) > 20 or any(len(c) > 120 for c in CAPABILITIES):
    problems.append("capabilities: at most 20, each at most 120 chars")
for k, u in URLS.items():
    if not u.startswith("https://"):
        problems.append(f"{k} is not https")
cases = review["test_cases"]
if len(cases["positive"]) != 5 or len(cases["negative"]) != 3:
    problems.append("review needs exactly five positive and three negative cases")
for c in cases["positive"]:
    for k in ("description", "prompt", "tools_triggered", "expected_behavior"):
        if not (c.get(k) or "").strip():
            problems.append(f"positive case {c.get('description')!r} has no {k}")
for c in cases["negative"]:
    for k in ("description", "prompt"):
        if not (c.get(k) or "").strip():
            problems.append(f"negative case {c.get('description')!r} has no {k}")
if "getting-started" not in skill_names:
    problems.append("onboardingSkill points at a skill that is not packaged")
blob = json.dumps(manifest)
for banned in ("test_credentials", "reviewer_instructions", '"apps"', '"hooks"'):
    if banned in blob:
        problems.append(f"manifest contains {banned}, which the portal rejects")

def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    return struct.unpack(">II", head[16:24]) if head[:8] == b"\x89PNG\r\n\x1a\n" else None

for rel in [ui["logo"], ui["composerIcon"], *ui.get("screenshots", []), manifest["extensions"]["com.openai"]["onboardingSkill"]]:
    path = os.path.join(STAGE, rel[2:])
    if not rel.startswith("./") or not os.path.isfile(path):
        problems.append(f"{rel} is referenced but not packaged")
        continue
    if os.path.getsize(path) > 5 * 1024 * 1024:
        problems.append(f"{rel} is over 5 MiB")
    size = png_size(path) if path.endswith(".png") else None
    if size and max(size) > 4096:
        problems.append(f"{rel} is {size[0]}x{size[1]}, over 4096")

if problems:
    print("PROBLEMS:")
    for p in problems:
        print(" -", p)
    sys.exit(1)

# ---------------------------------------------------------------------- zip
zip_path = os.path.join(DIST, f"{FILE_STEM}-plugin-{VERSION}.zip")
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
    for src in sorted(glob.glob(os.path.join(STAGE, "**", "*"), recursive=True)):
        if os.path.isfile(src):
            rel = os.path.relpath(src, STAGE).replace(os.sep, "/")
            z.write(src, f"{FILE_STEM}/{rel}" if args.folder else rel)

print("wrote", zip_path)
dl = os.path.join(os.path.expanduser("~"), "Downloads")
if os.path.isdir(dl):
    shutil.copy(zip_path, os.path.join(dl, os.path.basename(zip_path)))
    print("copied to", os.path.join(dl, os.path.basename(zip_path)))
print(f"skills: {', '.join(skill_names)}")
print(f"screenshots: {len(screenshots)} | positive: {len(cases['positive'])} | negative: {len(cases['negative'])}")
print("demo_recording_url:", args.demo_url or "NOT SET (required before Submit for review)")
