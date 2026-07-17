// Offline unit tests for the compose/attachment/draft patches.
// Following the repo convention (see auth-error.test.ts), these mirror the pure logic in
// src/index.ts so they can run without a live Gmail account. Keep them in sync with the source.

type MessagePart = {
  mimeType?: string
  filename?: string
  body?: { data?: string; size?: number; attachmentId?: string }
  headers?: { name?: string; value?: string }[]
  parts?: MessagePart[]
}

// ---- mirrors of src/index.ts helpers ----

const wrapBase64 = (base64: string) => (base64.replace(/\s+/g, '').match(/.{1,76}/g) || []).join('\r\n')

const buildTextPart = (text: string) => [
  'Content-Type: text/plain; charset="UTF-8"',
  'Content-Transfer-Encoding: base64',
  '',
  wrapBase64(Buffer.from(text, 'utf-8').toString('base64'))
]

const findPartByAttachmentId = (part: MessagePart | undefined, attachmentId: string): MessagePart | undefined => {
  if (!part) return undefined
  if (part.body?.attachmentId === attachmentId) return part
  for (const sub of part.parts || []) {
    const found = findPartByAttachmentId(sub, attachmentId)
    if (found) return found
  }
  return undefined
}

type AttachmentInfo = { id: string; filename: string; mimeType?: string; size?: number }
const collectAttachments = (part?: MessagePart): AttachmentInfo[] => {
  const out: AttachmentInfo[] = []
  const walk = (p?: MessagePart) => {
    if (!p) return
    const attachmentId = p.body?.attachmentId
    if (p.filename && attachmentId) {
      out.push({ id: attachmentId, filename: p.filename, mimeType: p.mimeType ?? undefined, size: p.body?.size ?? undefined })
    }
    p.parts?.forEach(walk)
  }
  walk(part)
  return out
}

// mirror of the update_draft body/html preservation decision (src/index.ts update_draft handler)
const resolveDraftContent = (
  input: { body?: string; htmlBody?: string },
  draft: { oldHtml?: string; oldPlain?: string }
) => {
  const out: { body?: string; htmlBody?: string; skipQuotedContent: boolean } = {
    body: input.body, htmlBody: input.htmlBody, skipQuotedContent: false
  }
  if (input.body === undefined && input.htmlBody === undefined) {
    if (draft.oldHtml) out.htmlBody = draft.oldHtml
    else if (draft.oldPlain !== undefined) out.body = draft.oldPlain
    out.skipQuotedContent = true
  }
  return out
}

// ---- tests ----

describe('buildTextPart (Fix 5: base64 plain-text)', () => {
  it('labels the part base64, not quoted-printable', () => {
    const part = buildTextPart('hello')
    expect(part).toContain('Content-Transfer-Encoding: base64')
    expect(part.join('\n')).not.toContain('quoted-printable')
  })

  it('round-trips Hebrew UTF-8 intact', () => {
    const hebrew = 'שלום עודד, כפי שסיכמנו — endpoint לכל דוח.'
    const b64 = buildTextPart(hebrew).at(-1)!.replace(/\r\n/g, '')
    expect(Buffer.from(b64, 'base64').toString('utf-8')).toBe(hebrew)
  })

  it('wraps long base64 output at 76 chars', () => {
    const long = 'x'.repeat(500)
    const b64line = buildTextPart(long).at(-1)!
    for (const line of b64line.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76)
  })
})

describe('collectAttachments / findPartByAttachmentId (Fix 1 & 2)', () => {
  const payload: MessagePart = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/plain', body: { data: 'aGk' } },
      { mimeType: 'application/pdf', filename: 'report.pdf', body: { attachmentId: 'ATT_pdf', size: 1234 } },
      {
        mimeType: 'multipart/related',
        parts: [{ mimeType: 'image/png', filename: 'logo.png', body: { attachmentId: 'ATT_png', size: 55 } }]
      }
    ]
  }

  it('returns a compact manifest of real attachments only', () => {
    expect(collectAttachments(payload)).toEqual([
      { id: 'ATT_pdf', filename: 'report.pdf', mimeType: 'application/pdf', size: 1234 },
      { id: 'ATT_png', filename: 'logo.png', mimeType: 'image/png', size: 55 }
    ])
  })

  it('ignores inline body parts with no attachmentId', () => {
    expect(collectAttachments({ parts: [{ mimeType: 'text/plain', body: { data: 'aGk' } }] })).toEqual([])
  })

  it('finds a nested part by attachment id', () => {
    expect(findPartByAttachmentId(payload, 'ATT_png')?.filename).toBe('logo.png')
    expect(findPartByAttachmentId(payload, 'nope')).toBeUndefined()
  })
})

describe('update_draft body sync (Fix 3)', () => {
  it('htmlBody-only edit leaves body undefined so plain is regenerated from the new HTML', () => {
    const r = resolveDraftContent({ htmlBody: '<b>new</b>' }, { oldHtml: '<b>old</b>', oldPlain: 'old' })
    expect(r.htmlBody).toBe('<b>new</b>')
    expect(r.body).toBeUndefined()
    expect(r.skipQuotedContent).toBe(false)
  })

  it('metadata-only edit preserves the existing HTML (keeps the alternative, no strip)', () => {
    const r = resolveDraftContent({}, { oldHtml: '<b>keep</b>', oldPlain: 'stale' })
    expect(r.htmlBody).toBe('<b>keep</b>')
    expect(r.body).toBeUndefined()
    expect(r.skipQuotedContent).toBe(true)
  })

  it('metadata-only edit on a plain-text draft preserves the plain body', () => {
    const r = resolveDraftContent({}, { oldPlain: 'keep me' })
    expect(r.body).toBe('keep me')
    expect(r.htmlBody).toBeUndefined()
    expect(r.skipQuotedContent).toBe(true)
  })

  it('body-only edit is honored as plain text (no HTML resurrected)', () => {
    const r = resolveDraftContent({ body: 'plain now' }, { oldHtml: '<b>old</b>' })
    expect(r.body).toBe('plain now')
    expect(r.htmlBody).toBeUndefined()
  })
})
