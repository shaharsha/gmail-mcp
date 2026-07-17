---
"@shinzolabs/gmail-mcp": minor
---

Attachment handling, draft body-sync, and encoding fixes for AI-agent use:

- **`get_attachment` now writes bytes to a file by default** (returns `{path, filename, mimeType, size, sha256}`) instead of returning base64 into the caller's context, which is unusable for binary files. Pass `inline: true` for the old base64 behavior. **Breaking** for callers that relied on the base64 return.
- **New `list_attachments`** tool: a compact `{id, filename, mimeType, size}[]` so callers can get an attachment id without walking the full MIME tree.
- **`get_message` gains `format: "text"`**: headers + decoded plain-text body + an attachment manifest, keeping rich HTML/image emails from blowing up context.
- **`update_draft` keeps `text/plain` in sync with the HTML**: updating only `htmlBody` regenerates the plain-text part (previously it went stale); metadata-only edits preserve the HTML part instead of silently stripping it.
- **Plain-text bodies are base64-encoded** instead of labelled `quoted-printable` over raw UTF-8, fixing mojibake of non-ASCII (Hebrew/Arabic) plain-text bodies in strict clients.
