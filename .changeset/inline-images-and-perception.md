---
"@shinzolabs/gmail-mcp": minor
---

Inline in-body images, richer message introspection, and image perception:

- **Inline images (cid):** attachments now accept `contentId` and, when `inline: true` with an `htmlBody`, are emitted in a `multipart/related` container with a `Content-ID` header — so `<img src="cid:...">` resolves in the body instead of rendering as a broken image.
- **Per-part headers exposed:** `get_message`/`get_draft` (full format) now return each part's `Content-Type`, `Content-ID`, and `Content-Disposition` instead of stripping them — makes MIME structure and inline images introspectable.
- **`list_attachments` finds everything:** now lists every part with bytes (including inline images with no filename, synthesized from Content-ID/index) and flags `inline`/`contentId`.
- **`get_attachment` perception:** new `perceive: true` returns an image as a viewable image content block (magic-byte sniffed, size-capped) so an agent can SEE a chart/screenshot in one call instead of saving and reopening.
- **`get_message` friendlier 404:** a "not found" on a draft's message id now hints to use `get_draft`.
- **Compose descriptions:** `send_message` flags that sending is irreversible and names `create_draft`/`send_draft` alternatives; `create_draft` documents its return shape and alternatives.
