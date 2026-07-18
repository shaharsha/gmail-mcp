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

// ---- Round 2: inline images (cid + multipart/related) & per-part headers ----

const encodeHeaderFilename = (key: string, filename: string) =>
  /^[\x20-\x7E]*$/.test(filename)
    ? `${key}="${filename.replace(/"/g, '')}"`
    : `${key}*=UTF-8''${encodeURIComponent(filename)}`

type Att = { filename?: string; mimeType?: string; content?: string; inline?: boolean; contentId?: string }

const contentIdFor = (attachment: Att, filename: string) =>
  (attachment.contentId || filename).replace(/[<>\s\r\n]/g, '')

const buildAttachmentPart = (attachment: Att, boundary: string): string => {
  const filename = attachment.filename || 'attachment'
  const mimeType = attachment.mimeType || 'application/octet-stream'
  let base64 = (attachment.content ?? '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '').replace(/=+$/, '')
  while (base64.length % 4) base64 += '='
  const wrapped = (base64.match(/.{1,76}/g) || []).join('\r\n')
  const disposition = attachment.inline ? 'inline' : 'attachment'
  const lines = [
    `--${boundary}`,
    `Content-Type: ${mimeType}; ${encodeHeaderFilename('name', filename)}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: ${disposition}; ${encodeHeaderFilename('filename', filename)}`
  ]
  if (attachment.inline) lines.push(`Content-ID: <${contentIdFor(attachment, filename)}>`)
  lines.push('', wrapped)
  return lines.join('\r\n')
}

// mirror of the attachment split + related/mixed nesting decision in constructRawMessage
const assembleBody = (htmlBody: string | undefined, atts: Att[]) => {
  const inner = htmlBody !== undefined
    ? ['Content-Type: multipart/alternative; boundary="ALT"', '', '--ALT', 'text/plain', '--ALT', 'text/html', '--ALT--']
    : ['text/plain']
  const inlineAtts = htmlBody !== undefined ? atts.filter(a => a.inline) : []
  const regularAtts = atts.filter(a => !inlineAtts.includes(a))
  let content: string[]
  if (inlineAtts.length) {
    content = [
      'Content-Type: multipart/related; type="multipart/alternative"; boundary="REL"', '',
      '--REL', ...inner, ...inlineAtts.map(a => buildAttachmentPart(a, 'REL')), '--REL--'
    ]
  } else content = inner
  let message: string[]
  if (regularAtts.length) {
    message = ['Content-Type: multipart/mixed; boundary="MIX"', '', '--MIX', ...content,
      ...regularAtts.map(a => buildAttachmentPart(a, 'MIX')), '--MIX--']
  } else message = content
  return message.join('\r\n')
}

const IMG = 'iVBORw0KGgo='

describe('inline attachment Content-ID (Item 1)', () => {
  it('inline part carries Content-ID and Content-Disposition: inline', () => {
    const part = buildAttachmentPart({ filename: 'chart.png', mimeType: 'image/png', content: IMG, inline: true, contentId: 'chart' }, 'B')
    expect(part).toContain('Content-ID: <chart>')
    expect(part).toContain('Content-Disposition: inline')
  })
  it('contentId defaults to the filename', () => {
    const part = buildAttachmentPart({ filename: 'logo.png', content: IMG, inline: true }, 'B')
    expect(part).toContain('Content-ID: <logo.png>')
  })
  it('sanitizes header-unsafe chars from contentId', () => {
    expect(contentIdFor({ contentId: 'a b<>\r\nc' }, 'f')).toBe('abc')
  })
  it('regular (non-inline) part has no Content-ID and disposition attachment', () => {
    const part = buildAttachmentPart({ filename: 'report.pdf', content: IMG }, 'B')
    expect(part).not.toContain('Content-ID')
    expect(part).toContain('Content-Disposition: attachment')
  })
})

describe('multipart/related nesting (Item 1)', () => {
  it('htmlBody + inline image => multipart/related wrapping the alternative + cid image', () => {
    const body = assembleBody('<img src="cid:chart">', [{ filename: 'chart.png', content: IMG, inline: true, contentId: 'chart' }])
    expect(body).toContain('multipart/related')
    expect(body).toContain('multipart/alternative')
    expect(body).toContain('Content-ID: <chart>')
    expect(body).not.toContain('multipart/mixed') // no regular attachments
  })
  it('inline image + a real attachment => mixed[ related[alternative,image], attachment ]', () => {
    const body = assembleBody('<img src="cid:chart">', [
      { filename: 'chart.png', content: IMG, inline: true, contentId: 'chart' },
      { filename: 'report.pdf', content: IMG }
    ])
    expect(body.indexOf('multipart/mixed')).toBeLessThan(body.indexOf('multipart/related')) // mixed is outer
    expect(body).toContain('Content-ID: <chart>')
    expect(body).toContain('filename="report.pdf"')
  })
  it('inline image but NO htmlBody => falls back to a normal attachment (no related)', () => {
    const body = assembleBody(undefined, [{ filename: 'chart.png', content: IMG, inline: true }])
    expect(body).not.toContain('multipart/related')
    expect(body).toContain('multipart/mixed')
  })
})

describe('per-part header exposure (Item 2)', () => {
  const RESPONSE_HEADERS_LIST = ['Date', 'From', 'To', 'Cc', 'Bcc', 'Subject', 'Message-ID', 'In-Reply-To', 'References']
  const keep = (name: string) => RESPONSE_HEADERS_LIST.includes(name || '') || /^content-(type|id|disposition)$/i.test(name || '')
  it('keeps MIME part headers needed for introspection', () => {
    expect(keep('Content-Type')).toBe(true)
    expect(keep('Content-ID')).toBe(true)
    expect(keep('Content-Disposition')).toBe(true)
    expect(keep('content-id')).toBe(true) // case-insensitive
  })
  it('keeps top-level address headers, drops noise', () => {
    expect(keep('From')).toBe(true)
    expect(keep('Content-Transfer-Encoding')).toBe(false)
    expect(keep('X-Received')).toBe(false)
  })
})
