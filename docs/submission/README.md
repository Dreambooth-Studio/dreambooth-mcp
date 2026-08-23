# ChatGPT app submission — import file

`build_submission_import.py` writes `chatgpt-app-submission.json` next to itself
(`docs/submission/`, gitignored) in the shape the portal's **Import** accepts — the schema in
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
