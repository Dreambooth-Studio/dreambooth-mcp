# ChatGPT plugin submission

## Plugin ZIP (current portal)

Since 2026-09 the portal at platform.openai.com/plugins takes a **plugin ZIP**
through **Upload new version**, not the import file below. `build_plugin_zip.py`
assembles it:

    python docs/submission/build_plugin_zip.py --demo-url <video walkthrough URL>

| in the ZIP | from |
|---|---|
| `plugin.json` | listing copy and test cases from `build_submission_import.py`; URLs and starter prompts from `docs/chatgpt-listing.md` §2-3; version, release notes and capabilities at the top of the builder |
| `mcp.json` | the one remote server, `https://mcp.dreamboothstudio.com/mcp` (changing the URL needs OpenAI support) |
| `skills/` | `chatgpt-skills/*`, with LF line endings |
| `assets/` | `plugin-assets/logo.svg` (the ring from `src/ui/shell.ts`), plus `.screenshots/portal/*.png` when they have been rendered |

It writes `dist-plugin/` (gitignored) and copies the ZIP to `~/Downloads`. It
checks the field limits from the portal's reference before zipping, because an
upload accepts draft text that later fails at submit.

What the ZIP does NOT carry:

- **Tool annotations and justifications.** The portal scans them from the live
  server. Fix a tool on the server, deploy, then **Rescan** in the MCPs tab.
- **Reviewer credentials.** The portal rejects `test_credentials` and
  `reviewer_instructions` in a package; enter them in **Review details**.
- **The video walkthrough** unless `--demo-url` is given. It is required before
  **Submit for review**; leaving it out of a later upload keeps the saved one.

Bump `VERSION` in the builder for every upload. Each upload is its own package
version with its own checks and review.

## Import file (previous form)

`build_submission_import.py` writes `chatgpt-app-submission.json` next to itself
(`docs/submission/`, gitignored) in the shape the old portal's **Import** accepted — the schema in
`chatgpt-app-submission.v1.json` (`$schema`, `schema_version: 1`, `app_info`,
`tools` keyed by action name with annotations + justifications, exactly five
`test_cases` and three `negative_test_cases`). It also copies the file to
`~/Downloads` for the upload.

    python docs/submission/build_submission_import.py

Keep it in step with `src/mcp/server.ts` (annotations) and
`docs/chatgpt-listing.md` (copy, test cases). After a tool is added or an
annotation changes: update both, re-run, **re-scan tools in the portal**, then
import. The portal's own exports (`dreambooth-studio-*.json`) carry the reviewer
account's credentials and are gitignored too.
