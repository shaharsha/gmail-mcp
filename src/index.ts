#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createStatefulServer } from "@smithery/sdk/server/stateful.js"
import { z } from "zod"
import { google, gmail_v1 } from 'googleapis'
import fs from "fs"
import { createOAuth2Client, launchAuthServer, validateCredentials } from "./oauth2.js"
import { MCP_CONFIG_DIR, PORT, TELEMETRY_ENABLED } from "./config.js"
import { instrumentServer } from "@shinzolabs/instrumentation-mcp"

type Draft = gmail_v1.Schema$Draft
type DraftCreateParams = gmail_v1.Params$Resource$Users$Drafts$Create
type DraftUpdateParams = gmail_v1.Params$Resource$Users$Drafts$Update
type Message = gmail_v1.Schema$Message
type MessagePart = gmail_v1.Schema$MessagePart
type MessagePartBody = gmail_v1.Schema$MessagePartBody
type MessagePartHeader = gmail_v1.Schema$MessagePartHeader
type MessageSendParams = gmail_v1.Params$Resource$Users$Messages$Send
type Thread = gmail_v1.Schema$Thread

type Attachment = {
  filename?: string
  mimeType?: string
  content?: string
  path?: string
  inline?: boolean
}

type NewMessage = {
  threadId?: string
  raw?: string
  to?: string[] | undefined
  cc?: string[] | undefined
  bcc?: string[] | undefined
  subject?: string | undefined
  body?: string | undefined
  htmlBody?: string | undefined
  replyToMessageId?: string | undefined
  inReplyTo?: string | undefined
  references?: string | undefined
  includeBodyHtml?: boolean
  attachments?: Attachment[]
  skipQuotedContent?: boolean
}

const RESPONSE_HEADERS_LIST = [
  'Date',
  'From',
  'To',
  'Cc',
  'Bcc',
  'Subject',
  'Message-ID',
  'In-Reply-To',
  'References'
]

const defaultOAuth2Client = createOAuth2Client()

const defaultGmailClient = defaultOAuth2Client ? google.gmail({ version: 'v1', auth: defaultOAuth2Client }) : null

const formatResponse = (response: any) => ({ content: [{ type: "text", text: JSON.stringify(response) }] })

const handleTool = async (queryConfig: Record<string, any> | undefined, apiCall: (gmail: gmail_v1.Gmail) => Promise<any>) => {
  try {
    const oauth2Client = queryConfig ? createOAuth2Client(queryConfig) : defaultOAuth2Client
    if (!oauth2Client) throw new Error('OAuth2 client could not be created, please check your credentials')

    const credentialsAreValid = await validateCredentials(oauth2Client)
    if (!credentialsAreValid) throw new Error('OAuth2 credentials are invalid, please re-authenticate')

    const gmailClient = queryConfig ? google.gmail({ version: 'v1', auth: oauth2Client }) : defaultGmailClient
    if (!gmailClient) throw new Error('Gmail client could not be created, please check your credentials')

    const result = await apiCall(gmailClient)
    return result
  } catch (error: any) {
    // Check for specific authentication errors
    if (
      error.message?.includes("invalid_grant") ||
      error.message?.includes("refresh_token") ||
      error.message?.includes("invalid_client") ||
      error.message?.includes("unauthorized_client") ||
      error.code === 401 ||
      error.code === 403
    ) {
      return formatResponse({
        error: `Authentication failed: ${error.message}. Please re-authenticate by running: npx @shinzolabs/gmail-mcp auth`,
      });
    }

    return formatResponse({ error: `Tool execution failed: ${error.message}` });
  }
}

const decodedBody = (body: MessagePartBody) => {
  if (!body?.data) return body

  const decodedData = Buffer.from(body.data, 'base64').toString('utf-8')
  const decodedBody: MessagePartBody = {
    data: decodedData,
    size: body.data.length,
    attachmentId: body.attachmentId
  }
  return decodedBody
}

const processMessagePart = (messagePart: MessagePart, includeBodyHtml = false): MessagePart => {
  if ((messagePart.mimeType !== 'text/html' || includeBodyHtml) && messagePart.body) {
    messagePart.body = decodedBody(messagePart.body)
  }

  if (messagePart.parts) {
    messagePart.parts = messagePart.parts.map(part => processMessagePart(part, includeBodyHtml))
  }

  if (messagePart.headers) {
    messagePart.headers = messagePart.headers.filter(header => RESPONSE_HEADERS_LIST.includes(header.name || ''))
  }

  return messagePart
}

const getNestedHistory = (messagePart: MessagePart, level = 1): string => {
  if (messagePart.mimeType === 'text/plain' && messagePart.body?.data) {
    const { data } = decodedBody(messagePart.body)
    if (!data) return ''
    return data.split('\n').map(line => '>' + (line.startsWith('>') ? '' : ' ') + line).join('\n')
  }

  return (messagePart.parts || []).map(p => getNestedHistory(p, level + 1)).filter(p => p).join('\n')
}

const findHeader = (headers: MessagePartHeader[] | undefined, name: string) => {
  if (!headers || !Array.isArray(headers) || !name) return undefined
  return headers.find(h => h?.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined
}

const formatEmailList = (emailList: string | null | undefined) => {
  if (!emailList) return []
  return emailList.split(',').map(email => email.trim())
}

const getQuotedContent = (thread: Thread) => {
  if (!thread.messages?.length) return ''

  const sentMessages = thread.messages.filter(msg =>
    msg.labelIds?.includes('SENT') ||
    (!msg.labelIds?.includes('DRAFT') && findHeader(msg.payload?.headers || [], 'date'))
  )

  if (!sentMessages.length) return ''

  const lastMessage = sentMessages[sentMessages.length - 1]
  if (!lastMessage?.payload) return ''

  let quotedContent = []

  if (lastMessage.payload.headers) {
    const fromHeader = findHeader(lastMessage.payload.headers || [], 'from')
    const dateHeader = findHeader(lastMessage.payload.headers || [], 'date')
    if (fromHeader && dateHeader) {
      quotedContent.push('')
      quotedContent.push(`On ${dateHeader} ${fromHeader} wrote:`)
      quotedContent.push('')
    }
  }

  const nestedHistory = getNestedHistory(lastMessage.payload)
  if (nestedHistory) {
    quotedContent.push(nestedHistory)
    quotedContent.push('')
  }

  return quotedContent.join('\n')
}

// Derive reply headers (Re: subject, In-Reply-To, References) from a message's headers.
const deriveReply = (msgHeaders: MessagePartHeader[]) => {
  let subject = findHeader(msgHeaders, 'subject') || ''
  if (subject && !subject.toLowerCase().startsWith('re:')) subject = `Re: ${subject}`
  const messageId = findHeader(msgHeaders, 'message-id')
  const refsHeader = findHeader(msgHeaders, 'references')
  const references = messageId
    ? [refsHeader, messageId].filter(Boolean).join(' ')
    : (refsHeader || undefined)
  return {
    subject: subject || undefined,
    inReplyTo: messageId || undefined,
    references: references || undefined
  }
}

const wrapTextBody = (text: string): string => text.split('\n').map(line => {
  if (line.length <= 76) return line
  const chunks = line.match(/.{1,76}/g) || []
  return chunks.join('=\n')
}).join('\n')

// Strip CR/LF from header values to prevent RFC822 header injection via user-controlled fields.
const sanitizeHeaderValue = (value: string) => value.replace(/[\r\n]+/g, ' ').trim()

// RFC 5322 header folding: wrap long headers onto continuation lines (CRLF + space),
// breaking after commas (address lists). Never emits quoted-printable "=\n" (which is invalid in headers).
const foldHeader = (name: string, value: string): string => {
  if (`${name}: ${value}`.length <= 78) return `${name}: ${value}`
  const segments = value.split(', ')
  const lines: string[] = []
  let line = `${name}:`
  segments.forEach((seg, i) => {
    const token = i < segments.length - 1 ? `${seg},` : seg
    const candidate = `${line} ${token}`
    if (candidate.length > 78 && line !== `${name}:`) {
      lines.push(line)
      line = ` ${token}`
    } else {
      line = candidate
    }
  })
  lines.push(line)
  return lines.join('\r\n')
}

// RFC 2047 encoded-word for non-ASCII header text. ASCII passes through untouched.
const isAscii = (s: string) => /^[\x00-\x7F]*$/.test(s)

const encodeWord = (text: string): string => {
  const bytes = Buffer.from(text, 'utf-8')
  const maxBytes = 36 // 36B -> base64 48ch -> word 60ch, safely under the RFC 2047 75ch encoded-word limit
  const words: string[] = []
  for (let i = 0; i < bytes.length;) {
    let end = Math.min(i + maxBytes, bytes.length)
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end-- // don't split a UTF-8 sequence
    words.push(`=?UTF-8?B?${bytes.subarray(i, end).toString('base64')}?=`)
    i = end
  }
  return words.join('\r\n ') // fold between encoded-words with CRLF + space
}

// Encode only a display name (never the addr-spec) for non-ASCII addresses.
const encodeAddress = (addr: string): string => {
  const value = sanitizeHeaderValue(addr)
  const match = value.match(/^(.*?)\s*<([^>]+)>$/)
  if (!match) return value // bare addr-spec, e.g. a@b.com
  const name = match[1].replace(/^"(.*)"$/, '$1')
  if (!name) return `<${match[2]}>`
  return `${isAscii(name) ? `"${name.replace(/"/g, '')}"` : encodeWord(name)} <${match[2]}>`
}

// Depth-first search for the first part of a given MIME type that carries inline body data.
const findPartByMime = (part: MessagePart | undefined, mimeType: string): MessagePart | undefined => {
  if (!part) return undefined
  if (part.mimeType === mimeType && part.body?.data) return part
  for (const sub of part.parts || []) {
    const found = findPartByMime(sub, mimeType)
    if (found) return found
  }
  return undefined
}

const MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
  html: 'text/html', htm: 'text/html', xml: 'application/xml', zip: 'application/zip',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg', mp4: 'video/mp4', mov: 'video/quicktime'
}

const guessMimeType = (filename: string) => {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : ''
  return MIME_TYPES[ext] || 'application/octet-stream'
}

// Plain quoted form for ASCII filenames; RFC 2231 extended form for non-ASCII.
const encodeHeaderFilename = (key: string, filename: string) =>
  /^[\x20-\x7E]*$/.test(filename)
    ? `${key}="${filename.replace(/"/g, '')}"`
    : `${key}*=UTF-8''${encodeURIComponent(filename)}`

const buildAttachmentPart = (attachment: Attachment, boundary: string): string => {
  const filename = attachment.filename || (attachment.path ? attachment.path.split('/').pop()! : 'attachment')
  const mimeType = attachment.mimeType || guessMimeType(filename)
  let base64 = attachment.content ?? (attachment.path ? fs.readFileSync(attachment.path).toString('base64') : '')
  if (!base64) throw new Error(`Attachment "${filename}" has neither content nor a readable path`)
  // Accept standard or url-safe base64 input; normalize and pad, then wrap at 76 chars (RFC 2045).
  base64 = base64.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '').replace(/=+$/, '')
  while (base64.length % 4) base64 += '='
  const wrapped = (base64.match(/.{1,76}/g) || []).join('\r\n')
  const disposition = attachment.inline ? 'inline' : 'attachment'
  return [
    `--${boundary}`,
    `Content-Type: ${mimeType}; ${encodeHeaderFilename('name', filename)}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: ${disposition}; ${encodeHeaderFilename('filename', filename)}`,
    '',
    wrapped
  ].join('\r\n')
}

const wrapBase64 = (base64: string) => (base64.replace(/\s+/g, '').match(/.{1,76}/g) || []).join('\r\n')

const buildTextPart = (text: string) => [
  'Content-Type: text/plain; charset="UTF-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  text
]

const buildHtmlPart = (html: string) => [
  'Content-Type: text/html; charset="UTF-8"',
  'Content-Transfer-Encoding: base64',
  '',
  wrapBase64(Buffer.from(html, 'utf-8').toString('base64'))
]

// Minimal HTML -> plain-text fallback for the text/plain alternative when only htmlBody is given.
const htmlToPlainText = (html: string) => html
  .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
  .replace(/\n{3,}/g, '\n\n')
  .trim()

const constructRawMessage = async (gmail: gmail_v1.Gmail, params: NewMessage) => {
  // Resolve reply context from an explicit message id (most precise) or the thread's last message.
  let reply: { subject?: string; inReplyTo?: string; references?: string } = {}
  if (params.replyToMessageId) {
    const { data: original } = await gmail.users.messages.get({
      userId: 'me', id: params.replyToMessageId, format: 'metadata', metadataHeaders: ['Subject', 'Message-ID', 'References']
    })
    reply = deriveReply(original.payload?.headers || [])
    if (!params.threadId && original.threadId) params.threadId = original.threadId
  }

  let thread: Thread | null = null
  if (params.threadId) {
    const { data } = await gmail.users.threads.get({ userId: 'me', id: params.threadId, format: 'full' })
    thread = data
    if (!params.replyToMessageId && thread.messages?.length) {
      reply = deriveReply(thread.messages[thread.messages.length - 1].payload?.headers || [])
    }
  }

  // Headers — explicit params always override reply-derived values.
  const headers: string[] = []
  if (params.to?.length) headers.push(foldHeader('To', params.to.map(encodeAddress).join(', ')))
  if (params.cc?.length) headers.push(foldHeader('Cc', params.cc.map(encodeAddress).join(', ')))
  if (params.bcc?.length) headers.push(foldHeader('Bcc', params.bcc.map(encodeAddress).join(', ')))

  const subject = params.subject !== undefined ? params.subject : (reply.subject ?? '(No Subject)')
  const cleanSubject = sanitizeHeaderValue(subject)
  headers.push(isAscii(cleanSubject) ? foldHeader('Subject', cleanSubject) : `Subject: ${encodeWord(cleanSubject)}`)

  const inReplyTo = params.inReplyTo ?? reply.inReplyTo
  const references = params.references ?? reply.references
  if (inReplyTo) headers.push(`In-Reply-To: ${sanitizeHeaderValue(inReplyTo)}`)
  if (references) headers.push(`References: ${sanitizeHeaderValue(references)}`)
  headers.push('MIME-Version: 1.0')

  // Plain-text body (+ quoted reply history for threads).
  const bodyParts: string[] = []
  if (params.body) bodyParts.push(wrapTextBody(params.body))
  else if (params.htmlBody !== undefined) bodyParts.push(wrapTextBody(htmlToPlainText(params.htmlBody)))
  if (thread && !params.skipQuotedContent) {
    const quotedContent = getQuotedContent(thread)
    if (quotedContent) {
      bodyParts.push('')
      bodyParts.push(wrapTextBody(quotedContent))
    }
  }
  const textBody = bodyParts.join('\r\n')

  const rand = () => `${Date.now()}_${Math.floor(Math.random() * 1e9)}`

  // Inner content: a single text/plain part, or multipart/alternative (text + html) when htmlBody is given.
  let inner: string[]
  if (params.htmlBody !== undefined) {
    const altBoundary = `----=_Alt_${rand()}`
    inner = [
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`, '',
      `--${altBoundary}`, ...buildTextPart(textBody),
      `--${altBoundary}`, ...buildHtmlPart(params.htmlBody),
      `--${altBoundary}--`
    ]
  } else {
    inner = buildTextPart(textBody)
  }

  // Wrap in multipart/mixed when there are attachments.
  const message: string[] = [...headers]
  if (params.attachments?.length) {
    const mixedBoundary = `----=_Mixed_${rand()}`
    message.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`, '')
    message.push(`--${mixedBoundary}`, ...inner)
    for (const attachment of params.attachments) message.push(buildAttachmentPart(attachment, mixedBoundary))
    message.push(`--${mixedBoundary}--`)
  } else {
    message.push(...inner)
  }

  return Buffer.from(message.join('\r\n')).toString('base64url').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function getConfig(config: any) {
  return {
    telemetryEnabled: config?.TELEMETRY_ENABLED || TELEMETRY_ENABLED
  }
}

function createServer({ config }: { config?: Record<string, any> }) {
  const serverInfo = {
    name: "Gmail-MCP",
    version: "1.7.4",
    description: "Gmail MCP - Provides complete Gmail API access with file-based OAuth2 authentication"
  }

  const server = new McpServer(serverInfo)

  const { telemetryEnabled } = getConfig(config)

  if (telemetryEnabled !== "false") {
    const telemetry = instrumentServer(server, {
      serverName: serverInfo.name,
      serverVersion: serverInfo.version,
      exporterEndpoint: "https://api.otel.shinzo.tech/v1"
    })
  }

  server.tool("create_draft",
    "Create a draft email in Gmail. Note the mechanics of the raw parameter.",
    {
      raw: z.string().optional().describe("The entire email message in base64url encoded RFC 2822 format, ignores params.to, cc, bcc, subject, body, includeBodyHtml if provided"),
      threadId: z.string().optional().describe("The thread ID to associate this draft with"),
      to: z.array(z.string()).optional().describe("List of recipient email addresses"),
      cc: z.array(z.string()).optional().describe("List of CC recipient email addresses"),
      bcc: z.array(z.string()).optional().describe("List of BCC recipient email addresses"),
      subject: z.string().optional().describe("The subject of the email"),
      body: z.string().optional().describe("The body of the email"),
      includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return for each body, excluded by default because they can be excessively large"),
      attachments: z.array(z.object({
        filename: z.string().optional().describe("Attachment filename, e.g. report.pdf. Inferred from the path if omitted."),
        mimeType: z.string().optional().describe("MIME type, e.g. application/pdf. Inferred from the filename extension if omitted."),
        content: z.string().optional().describe("Base64-encoded file content. Provide either content or path; prefer path for large files to keep requests small."),
        path: z.string().optional().describe("Local filesystem path for the server to read and attach. Provide either path or content."),
        inline: z.boolean().optional().describe("Attach inline (e.g. an image referenced from HTML) rather than as a downloadable file. Defaults to false.")
      })).optional().describe("Files to attach to the message"),
      htmlBody: z.string().optional().describe("HTML body. When set, the message is sent as multipart/alternative; the plain-text part comes from body, or is auto-generated from the HTML when body is omitted."),
      replyToMessageId: z.string().optional().describe("Message ID being replied to. Auto-populates In-Reply-To/References, the thread association, and a Re: subject (each overridable by the matching explicit param)."),
      inReplyTo: z.string().optional().describe("Manual In-Reply-To header (the Message-ID being replied to). Normally set automatically via replyToMessageId."),
      references: z.string().optional().describe("Manual References header (space-separated Message-IDs). Normally set automatically via replyToMessageId.")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        let raw = params.raw
        if (!raw) raw = await constructRawMessage(gmail, params)

        const draftCreateParams: DraftCreateParams = { userId: 'me', requestBody: { message: { raw } } }
        if (params.threadId && draftCreateParams.requestBody?.message) {
          draftCreateParams.requestBody.message.threadId = params.threadId
        }

        const { data } = await gmail.users.drafts.create(draftCreateParams)

        if (data.message?.payload) {
          data.message.payload = processMessagePart(
            data.message.payload,
            params.includeBodyHtml
          )
        }

        return formatResponse(data)
      })
    }
  )

  server.tool("delete_draft",
    "Delete a draft",
    {
      id: z.string().describe("The ID of the draft to delete")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.drafts.delete({ userId: 'me', id: params.id })
        return formatResponse(data)
      })
    }
  )

  server.tool("get_draft",
    "Get a specific draft by ID",
    {
      id: z.string().describe("The ID of the draft to retrieve"),
      includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return for each body, excluded by default because they can be excessively large")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.drafts.get({ userId: 'me', id: params.id, format: 'full' })

        if (data.message?.payload) {
          data.message.payload = processMessagePart(
            data.message.payload,
            params.includeBodyHtml
          )
        }

        return formatResponse(data)
      })
    }
  )

  server.tool("list_drafts",
    "List drafts in the user's mailbox",
    {
      maxResults: z.number().optional().describe("Maximum number of drafts to return. Accepts values between 1-500"),
      q: z.string().optional().describe("Only return drafts matching the specified query. Supports the same query format as the Gmail search box"),
      includeSpamTrash: z.boolean().optional().describe("Include drafts from SPAM and TRASH in the results"),
      includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return for each body, excluded by default because they can be excessively large"),
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        let drafts: Draft[] = []

        const { data } = await gmail.users.drafts.list({ userId: 'me', ...params })

        drafts.push(...data.drafts || [])

        while (data.nextPageToken) {
          const { data: nextData } = await gmail.users.drafts.list({ userId: 'me', ...params, pageToken: data.nextPageToken })
          drafts.push(...nextData.drafts || [])
        }

        if (drafts) {
          drafts = drafts.map(draft => {
            if (draft.message?.payload) {
              draft.message.payload = processMessagePart(
                draft.message.payload,
                params.includeBodyHtml
              )
            }
            return draft
          })
        }

        return formatResponse(drafts)
      })
    }
  )

  server.tool("send_draft",
    "Send an existing draft",
    {
      id: z.string().describe("The ID of the draft to send")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        try {
          const { data } = await gmail.users.drafts.send({ userId: 'me', requestBody: { id: params.id } })
          return formatResponse(data)
        } catch (error) {
          return formatResponse({ error: 'Error sending draft, are you sure you have at least one recipient?' })
        }
      })
    }
  )

  server.tool("update_draft",
    "Replace a draft's content. Note the mechanics of the threadId and raw parameters.",
    {
      id: z.string().describe("The ID of the draft to update"),
      threadId: z.string().optional().describe("The thread ID to associate this draft with, will be copied from the current draft if not provided"),
      raw: z.string().optional().describe("The entire email message in base64url encoded RFC 2822 format, ignores params.to, cc, bcc, subject, body, includeBodyHtml if provided"),
      to: z.array(z.string()).optional().describe("List of recipient email addresses, will be copied from the current draft if not provided"),
      cc: z.array(z.string()).optional().describe("List of CC recipient email addresses, will be copied from the current draft if not provided"),
      bcc: z.array(z.string()).optional().describe("List of BCC recipient email addresses, will be copied from the current draft if not provided"),
      subject: z.string().optional().describe("The subject of the email, will be copied from the current draft if not provided"),
      body: z.string().optional().describe("The body of the email, will be copied from the current draft if not provided"),
      includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return for each body, excluded by default because they can be excessively large"),
      attachments: z.array(z.object({
        filename: z.string().optional().describe("Attachment filename, e.g. report.pdf. Inferred from the path if omitted."),
        mimeType: z.string().optional().describe("MIME type, e.g. application/pdf. Inferred from the filename extension if omitted."),
        content: z.string().optional().describe("Base64-encoded file content. Provide either content or path; prefer path for large files to keep requests small."),
        path: z.string().optional().describe("Local filesystem path for the server to read and attach. Provide either path or content."),
        inline: z.boolean().optional().describe("Attach inline (e.g. an image referenced from HTML) rather than as a downloadable file. Defaults to false.")
      })).optional().describe("Files to attach to the message"),
      htmlBody: z.string().optional().describe("HTML body. When set, the message is sent as multipart/alternative; the plain-text part comes from body, or is auto-generated from the HTML when body is omitted."),
      replyToMessageId: z.string().optional().describe("Message ID being replied to. Auto-populates In-Reply-To/References, the thread association, and a Re: subject (each overridable by the matching explicit param)."),
      inReplyTo: z.string().optional().describe("Manual In-Reply-To header (the Message-ID being replied to). Normally set automatically via replyToMessageId."),
      references: z.string().optional().describe("Manual References header (space-separated Message-IDs). Normally set automatically via replyToMessageId.")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        let raw = params.raw
        const currentDraft = await gmail.users.drafts.get({ userId: 'me', id: params.id, format: 'full' })
        const { payload } = currentDraft.data.message ?? {}

        if (currentDraft.data.message?.threadId && !params.threadId) params.threadId = currentDraft.data.message.threadId
        if (!params.to) params.to = formatEmailList(findHeader(payload?.headers || [], 'to'))
        if (!params.cc) params.cc = formatEmailList(findHeader(payload?.headers || [], 'cc'))
        if (!params.bcc) params.bcc = formatEmailList(findHeader(payload?.headers || [], 'bcc'))
        if (params.subject === undefined) params.subject = findHeader(payload?.headers || [], 'subject') ?? undefined
        if (params.inReplyTo === undefined) params.inReplyTo = findHeader(payload?.headers || [], 'in-reply-to') ?? undefined
        if (params.references === undefined) params.references = findHeader(payload?.headers || [], 'references') ?? undefined
        if (params.body === undefined) {
          const bodyData = findPartByMime(payload, 'text/plain')?.body?.data ?? payload?.body?.data
          if (bodyData) params.body = Buffer.from(bodyData, 'base64url').toString('utf-8')
          // The preserved body already contains any quoted reply history; don't let constructRawMessage re-append it.
          params.skipQuotedContent = true
        }
        if (!params.attachments) {
          const existing: { filename: string; mimeType?: string; attachmentId: string }[] = []
          const collectAttachments = (part?: MessagePart) => {
            if (!part) return
            const attachmentId = part.body?.attachmentId
            if (part.filename && attachmentId) existing.push({ filename: part.filename, mimeType: part.mimeType ?? undefined, attachmentId })
            part.parts?.forEach(collectAttachments)
          }
          collectAttachments(payload)
          const messageId = currentDraft.data.message?.id
          if (existing.length && messageId) {
            params.attachments = []
            for (const att of existing) {
              const { data: attData } = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: att.attachmentId })
              if (attData.data) params.attachments.push({ filename: att.filename, mimeType: att.mimeType, content: attData.data })
            }
          }
        }

        if (!raw) raw = await constructRawMessage(gmail, params)

        const draftUpdateParams: DraftUpdateParams = { userId: 'me', id: params.id, requestBody: { message: { raw } } }
        if (params.threadId && draftUpdateParams.requestBody?.message) {
          draftUpdateParams.requestBody.message.threadId = params.threadId
        }

        const { data } = await gmail.users.drafts.update(draftUpdateParams)

        if (data.message?.payload) {
          data.message.payload = processMessagePart(
            data.message.payload,
            params.includeBodyHtml
          )
        }

        return formatResponse(data)
      })
    }
  )

  server.tool("create_label",
    "Create a new label",
    {
      name: z.string().describe("The display name of the label"),
      messageListVisibility: z.enum(['show', 'hide']).optional().describe("The visibility of messages with this label in the message list"),
      labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("The visibility of the label in the label list"),
      color: z.object({
        textColor: z.string().describe("The text color of the label as hex string"),
        backgroundColor: z.string().describe("The background color of the label as hex string")
      }).optional().describe("The color settings for the label")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.labels.create({ userId: 'me', requestBody: params })
        return formatResponse(data)
      })
    }
  )

  server.tool("delete_label",
    "Delete a label",
    {
      id: z.string().describe("The ID of the label to delete")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.labels.delete({ userId: 'me', id: params.id })
        return formatResponse(data)
      })
    }
  )

  server.tool("get_label",
    "Get a specific label by ID",
    {
      id: z.string().describe("The ID of the label to retrieve")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.labels.get({ userId: 'me', id: params.id })
        return formatResponse(data)
      })
    }
  )

  server.tool("list_labels",
    "List all labels in the user's mailbox",
    {},
    async () => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.labels.list({ userId: 'me' })
        return formatResponse(data)
      })
    }
  )

  server.tool("patch_label",
    "Patch an existing label (partial update)",
    {
      id: z.string().describe("The ID of the label to patch"),
      name: z.string().optional().describe("The display name of the label"),
      messageListVisibility: z.enum(['show', 'hide']).optional().describe("The visibility of messages with this label in the message list"),
      labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("The visibility of the label in the label list"),
      color: z.object({
        textColor: z.string().describe("The text color of the label as hex string"),
        backgroundColor: z.string().describe("The background color of the label as hex string")
      }).optional().describe("The color settings for the label")
    },
    async (params) => {
      const { id, ...labelData } = params
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.labels.patch({ userId: 'me', id, requestBody: labelData })
        return formatResponse(data)
      })
    }
  )

  server.tool("update_label",
    "Update an existing label",
    {
      id: z.string().describe("The ID of the label to update"),
      name: z.string().optional().describe("The display name of the label"),
      messageListVisibility: z.enum(['show', 'hide']).optional().describe("The visibility of messages with this label in the message list"),
      labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("The visibility of the label in the label list"),
      color: z.object({
        textColor: z.string().describe("The text color of the label as hex string"),
        backgroundColor: z.string().describe("The background color of the label as hex string")
      }).optional().describe("The color settings for the label")
    },
    async (params) => {
      const { id, ...labelData } = params
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.labels.update({ userId: 'me', id, requestBody: labelData })
        return formatResponse(data)
      })
    }
  )

  server.tool("batch_delete_messages",
    "Delete multiple messages",
    {
      ids: z.array(z.string()).describe("The IDs of the messages to delete")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.messages.batchDelete({ userId: 'me', requestBody: { ids: params.ids } })
        return formatResponse(data)
      })
    }
  )

  server.tool("batch_modify_messages",
    "Modify the labels on multiple messages",
    {
      ids: z.array(z.string()).describe("The IDs of the messages to modify"),
      addLabelIds: z.array(z.string()).optional().describe("A list of label IDs to add to the messages"),
      removeLabelIds: z.array(z.string()).optional().describe("A list of label IDs to remove from the messages")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.messages.batchModify({ userId: 'me', requestBody: { ids: params.ids, addLabelIds: params.addLabelIds, removeLabelIds: params.removeLabelIds } })
        return formatResponse(data)
      })
    }
  )

  server.tool("delete_message",
    "Immediately and permanently delete a message",
    {
      id: z.string().describe("The ID of the message to delete")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.messages.delete({ userId: 'me', id: params.id })
        return formatResponse(data)
      })
    }
  )

  server.tool("get_message",
    "Get a specific message by ID with format options",
    {
      id: z.string().describe("The ID of the message to retrieve"),
      format: z.enum(['full', 'metadata', 'minimal']).optional().describe("Gmail fetch format. 'full' (default) returns the parsed body; 'metadata' returns headers only (pair with metadataHeaders) and is far smaller; 'minimal' returns only ids/labels."),
      metadataHeaders: z.array(z.string()).optional().describe("When format is 'metadata', restrict the returned headers to these names, e.g. ['Subject','Message-ID','From']."),
      includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return for each body, excluded by default because they can be excessively large")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const format = params.format ?? 'full'
        const { data } = await gmail.users.messages.get({ userId: 'me', id: params.id, format, metadataHeaders: params.metadataHeaders })

        if (format === 'full' && data.payload) {
          data.payload = processMessagePart(data.payload, params.includeBodyHtml)
        }

        return formatResponse(data)
      })
    }
  )

  server.tool("list_messages",
    "List messages in the user's mailbox with optional filtering",
    {
      maxResults: z.number().optional().describe("Maximum number of messages to return. Accepts values between 1-500"),
      pageToken: z.string().optional().describe("Page token to retrieve a specific page of results"),
      q: z.string().optional().describe("Only return messages matching the specified query. Supports the same query format as the Gmail search box"),
      labelIds: z.array(z.string()).optional().describe("Only return messages with labels that match all of the specified label IDs"),
      includeSpamTrash: z.boolean().optional().describe("Include messages from SPAM and TRASH in the results"),
      includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return for each body, excluded by default because they can be excessively large"),
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.messages.list({ userId: 'me', ...params })

        if (data.messages) {
          data.messages = data.messages.map((message: Message) => {
            if (message.payload) {
              message.payload = processMessagePart(
                message.payload,
                params.includeBodyHtml
              )
            }
            return message
          })
        }

        return formatResponse(data)
      })
    }
  )

  server.tool("modify_message",
    "Modify the labels on a message",
    {
      id: z.string().describe("The ID of the message to modify"),
      addLabelIds: z.array(z.string()).optional().describe("A list of label IDs to add to the message"),
      removeLabelIds: z.array(z.string()).optional().describe("A list of label IDs to remove from the message")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.messages.modify({ userId: 'me', id: params.id, requestBody: { addLabelIds: params.addLabelIds, removeLabelIds: params.removeLabelIds } })
        return formatResponse(data)
      })
    }
  )

  server.tool("send_message",
    "Send an email message to specified recipients. Note the mechanics of the raw parameter.",
    {
      raw: z.string().optional().describe("The entire email message in base64url encoded RFC 2822 format, ignores params.to, cc, bcc, subject, body, includeBodyHtml if provided"),
      threadId: z.string().optional().describe("The thread ID to associate this message with"),
      to: z.array(z.string()).optional().describe("List of recipient email addresses"),
      cc: z.array(z.string()).optional().describe("List of CC recipient email addresses"),
      bcc: z.array(z.string()).optional().describe("List of BCC recipient email addresses"),
      subject: z.string().optional().describe("The subject of the email"),
      body: z.string().optional().describe("The body of the email"),
      includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return for each body, excluded by default because they can be excessively large"),
      attachments: z.array(z.object({
        filename: z.string().optional().describe("Attachment filename, e.g. report.pdf. Inferred from the path if omitted."),
        mimeType: z.string().optional().describe("MIME type, e.g. application/pdf. Inferred from the filename extension if omitted."),
        content: z.string().optional().describe("Base64-encoded file content. Provide either content or path; prefer path for large files to keep requests small."),
        path: z.string().optional().describe("Local filesystem path for the server to read and attach. Provide either path or content."),
        inline: z.boolean().optional().describe("Attach inline (e.g. an image referenced from HTML) rather than as a downloadable file. Defaults to false.")
      })).optional().describe("Files to attach to the message"),
      htmlBody: z.string().optional().describe("HTML body. When set, the message is sent as multipart/alternative; the plain-text part comes from body, or is auto-generated from the HTML when body is omitted."),
      replyToMessageId: z.string().optional().describe("Message ID being replied to. Auto-populates In-Reply-To/References, the thread association, and a Re: subject (each overridable by the matching explicit param)."),
      inReplyTo: z.string().optional().describe("Manual In-Reply-To header (the Message-ID being replied to). Normally set automatically via replyToMessageId."),
      references: z.string().optional().describe("Manual References header (space-separated Message-IDs). Normally set automatically via replyToMessageId.")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        let raw = params.raw
        if (!raw) raw = await constructRawMessage(gmail, params)

        const messageSendParams: MessageSendParams = { userId: 'me', requestBody: { raw } }
        if (params.threadId && messageSendParams.requestBody) {
          messageSendParams.requestBody.threadId = params.threadId
        }

        const { data } = await gmail.users.messages.send(messageSendParams)

        if (data.payload) {
          data.payload = processMessagePart(
            data.payload,
            params.includeBodyHtml
          )
        }

        return formatResponse(data)
      })
    }
  )

  server.tool("trash_message",
    "Move a message to the trash",
    {
      id: z.string().describe("The ID of the message to move to trash")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.messages.trash({ userId: 'me', id: params.id })
        return formatResponse(data)
      })
    }
  )

  server.tool("untrash_message",
    "Remove a message from the trash",
    {
      id: z.string().describe("The ID of the message to remove from trash")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.messages.untrash({ userId: 'me', id: params.id })
        return formatResponse(data)
      })
    }
  )

  server.tool("get_attachment",
    "Get a message attachment",
    {
      messageId: z.string().describe("ID of the message containing the attachment"),
      id: z.string().describe("The ID of the attachment"),
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.messages.attachments.get({ userId: 'me', messageId: params.messageId, id: params.id })
        return formatResponse(data)
      })
    }
  )

  server.tool("delete_thread",
    "Delete a thread",
    {
      id: z.string().describe("The ID of the thread to delete")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.threads.delete({ userId: 'me', id: params.id })
        return formatResponse(data)
      })
    }
  )

  server.tool("get_thread",
    "Get a specific thread by ID",
    {
      id: z.string().describe("The ID of the thread to retrieve"),
      format: z.enum(['full', 'metadata', 'minimal']).optional().describe("Gmail fetch format. 'full' (default) returns parsed bodies; 'metadata' returns headers only (pair with metadataHeaders) and is far smaller; 'minimal' returns only ids/labels."),
      metadataHeaders: z.array(z.string()).optional().describe("When format is 'metadata', restrict the returned headers to these names, e.g. ['Subject','Message-ID','From']."),
      includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return for each body, excluded by default because they can be excessively large")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const format = params.format ?? 'full'
        const { data } = await gmail.users.threads.get({ userId: 'me', id: params.id, format, metadataHeaders: params.metadataHeaders })

        if (format === 'full' && data.messages) {
          data.messages = data.messages.map(message => {
            if (message.payload) {
              message.payload = processMessagePart(message.payload, params.includeBodyHtml)
            }
            return message
          })
        }

        return formatResponse(data)
      })
    }
  )

  server.tool("list_threads",
    "List threads in the user's mailbox",
    {
      maxResults: z.number().optional().describe("Maximum number of threads to return"),
      pageToken: z.string().optional().describe("Page token to retrieve a specific page of results"),
      q: z.string().optional().describe("Only return threads matching the specified query"),
      labelIds: z.array(z.string()).optional().describe("Only return threads with labels that match all of the specified label IDs"),
      includeSpamTrash: z.boolean().optional().describe("Include threads from SPAM and TRASH in the results"),
      includeBodyHtml: z.boolean().optional().describe("Whether to include the parsed HTML in the return for each body, excluded by default because they can be excessively large"),
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.threads.list({ userId: 'me', ...params })

        if (data.threads) {
          data.threads = data.threads.map(thread => {
            if (thread.messages) {
              thread.messages = thread.messages.map(message => {
                if (message.payload) {
                  message.payload = processMessagePart(
                    message.payload,
                    params.includeBodyHtml
                  )
                }
                return message
              })
            }
            return thread
          })
        }

        return formatResponse(data)
      })
    }
  )

  server.tool("modify_thread",
    "Modify the labels applied to a thread",
    {
      id: z.string().describe("The ID of the thread to modify"),
      addLabelIds: z.array(z.string()).optional().describe("A list of label IDs to add to the thread"),
      removeLabelIds: z.array(z.string()).optional().describe("A list of label IDs to remove from the thread")
    },
    async (params) => {
      const { id, ...threadData } = params
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.threads.modify({ userId: 'me', id, requestBody: threadData })
        return formatResponse(data)
      })
    }
  )

  server.tool("trash_thread",
    "Move a thread to the trash",
    {
      id: z.string().describe("The ID of the thread to move to trash")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.threads.trash({ userId: 'me', id: params.id })
        return formatResponse(data)
      })
    }
  )

  server.tool("untrash_thread",
    "Remove a thread from the trash",
    {
      id: z.string().describe("The ID of the thread to remove from trash")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.threads.untrash({ userId: 'me', id: params.id })
        return formatResponse(data)
      })
    }
  )

  server.tool("get_auto_forwarding",
    "Gets auto-forwarding settings",
    {},
    async () => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.getAutoForwarding({ userId: 'me' })
        return formatResponse(data)
      })
    }
  )

  server.tool("get_imap",
    "Gets IMAP settings",
    {},
    async () => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.getImap({ userId: 'me' })
        return formatResponse(data)
      })
    }
  )

  server.tool("get_language",
    "Gets language settings",
    {},
    async () => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.getLanguage({ userId: 'me' })
        return formatResponse(data)
      })
    }
  )

  server.tool("get_pop",
    "Gets POP settings",
    {},
    async () => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.getPop({ userId: 'me' })
        return formatResponse(data)
      })
    }
  )

  server.tool("get_vacation",
    "Get vacation responder settings",
    {},
    async () => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.getVacation({ userId: 'me' })
        return formatResponse(data)
      })
    }
  )

  server.tool("update_auto_forwarding",
    "Updates automatic forwarding settings",
    {
      enabled: z.boolean().describe("Whether all incoming mail is automatically forwarded to another address"),
      emailAddress: z.string().describe("Email address to which messages should be automatically forwarded"),
      disposition: z.enum(['leaveInInbox', 'archive', 'trash', 'markRead']).describe("The state in which messages should be left after being forwarded")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.updateAutoForwarding({ userId: 'me', requestBody: params })
        return formatResponse(data)
      })
    }
  )

  server.tool("update_imap",
    "Updates IMAP settings",
    {
      enabled: z.boolean().describe("Whether IMAP is enabled for the account"),
      expungeBehavior: z.enum(['archive', 'trash', 'deleteForever']).optional().describe("The action that will be executed on a message when it is marked as deleted and expunged from the last visible IMAP folder"),
      maxFolderSize: z.number().optional().describe("An optional limit on the number of messages that can be accessed through IMAP")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.updateImap({ userId: 'me', requestBody: params })
        return formatResponse(data)
      })
    }
  )

  server.tool("update_language",
    "Updates language settings",
    {
      displayLanguage: z.string().describe("The language to display Gmail in, formatted as an RFC 3066 Language Tag")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.updateLanguage({ userId: 'me', requestBody: params })
        return formatResponse(data)
      })
    }
  )

  server.tool("update_pop",
    "Updates POP settings",
    {
      accessWindow: z.enum(['disabled', 'allMail', 'fromNowOn']).describe("The range of messages which are accessible via POP"),
      disposition: z.enum(['archive', 'trash', 'leaveInInbox']).describe("The action that will be executed on a message after it has been fetched via POP")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.updatePop({ userId: 'me', requestBody: params })
        return formatResponse(data)
      })
    }
  )

  server.tool("update_vacation",
    "Update vacation responder settings",
    {
      enableAutoReply: z.boolean().describe("Whether the vacation responder is enabled"),
      responseSubject: z.string().optional().describe("Optional subject line for the vacation responder auto-reply"),
      responseBodyPlainText: z.string().describe("Response body in plain text format"),
      restrictToContacts: z.boolean().optional().describe("Whether responses are only sent to contacts"),
      restrictToDomain: z.boolean().optional().describe("Whether responses are only sent to users in the same domain"),
      startTime: z.string().optional().describe("Start time for sending auto-replies (epoch ms)"),
      endTime: z.string().optional().describe("End time for sending auto-replies (epoch ms)")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.updateVacation({ userId: 'me', requestBody: params })
        return formatResponse(data)
      })
    }
  )

  server.tool("add_delegate",
    "Adds a delegate to the specified account",
    {
      delegateEmail: z.string().describe("Email address of delegate to add")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.delegates.create({ userId: 'me', requestBody: { delegateEmail: params.delegateEmail } })
        return formatResponse(data)
      })
    }
  )

  server.tool("remove_delegate",
    "Removes the specified delegate",
    {
      delegateEmail: z.string().describe("Email address of delegate to remove")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.delegates.delete({ userId: 'me', delegateEmail: params.delegateEmail })
        return formatResponse(data)
      })
    }
  )

  server.tool("get_delegate",
    "Gets the specified delegate",
    {
      delegateEmail: z.string().describe("The email address of the delegate to retrieve")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.delegates.get({ userId: 'me', delegateEmail: params.delegateEmail })
        return formatResponse(data)
      })
    }
  )

  server.tool("list_delegates",
    "Lists the delegates for the specified account",
    {},
    async () => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.delegates.list({ userId: 'me' })
        return formatResponse(data)
      })
    }
  )

  server.tool("create_filter",
    "Creates a filter",
    {
      criteria: z.object({
        from: z.string().optional().describe("The sender's display name or email address"),
        to: z.string().optional().describe("The recipient's display name or email address"),
        subject: z.string().optional().describe("Case-insensitive phrase in the message's subject"),
        query: z.string().optional().describe("A Gmail search query that specifies the filter's criteria"),
        negatedQuery: z.string().optional().describe("A Gmail search query that specifies criteria the message must not match"),
        hasAttachment: z.boolean().optional().describe("Whether the message has any attachment"),
        excludeChats: z.boolean().optional().describe("Whether the response should exclude chats"),
        size: z.number().optional().describe("The size of the entire RFC822 message in bytes"),
        sizeComparison: z.enum(['smaller', 'larger']).optional().describe("How the message size in bytes should be in relation to the size field")
      }).describe("Filter criteria"),
      action: z.object({
        addLabelIds: z.array(z.string()).optional().describe("List of labels to add to messages"),
        removeLabelIds: z.array(z.string()).optional().describe("List of labels to remove from messages"),
        forward: z.string().optional().describe("Email address that the message should be forwarded to")
      }).describe("Actions to perform on messages matching the criteria")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.filters.create({ userId: 'me', requestBody: params })
        return formatResponse(data)
      })
    }
  )

  server.tool("delete_filter",
    "Deletes a filter",
    {
      id: z.string().describe("The ID of the filter to be deleted")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.filters.delete({ userId: 'me', id: params.id })
        return formatResponse(data)
      })
    }
  )

  server.tool("get_filter",
    "Gets a filter",
    {
      id: z.string().describe("The ID of the filter to be fetched")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.filters.get({ userId: 'me', id: params.id })
        return formatResponse(data)
      })
    }
  )

  server.tool("list_filters",
    "Lists the message filters of a Gmail user",
    {},
    async () => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.filters.list({ userId: 'me' })
        return formatResponse(data)
      })
    }
  )

  server.tool("create_forwarding_address",
    "Creates a forwarding address",
    {
      forwardingEmail: z.string().describe("An email address to which messages can be forwarded")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.forwardingAddresses.create({ userId: 'me', requestBody: params })
        return formatResponse(data)
      })
    }
  )

  server.tool("delete_forwarding_address",
    "Deletes the specified forwarding address",
    {
      forwardingEmail: z.string().describe("The forwarding address to be deleted")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.forwardingAddresses.delete({ userId: 'me', forwardingEmail: params.forwardingEmail })
        return formatResponse(data)
      })
    }
  )

  server.tool("get_forwarding_address",
    "Gets the specified forwarding address",
    {
      forwardingEmail: z.string().describe("The forwarding address to be retrieved")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.forwardingAddresses.get({ userId: 'me', forwardingEmail: params.forwardingEmail })
        return formatResponse(data)
      })
    }
  )

  server.tool("list_forwarding_addresses",
    "Lists the forwarding addresses for the specified account",
    {},
    async () => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.forwardingAddresses.list({ userId: 'me' })
        return formatResponse(data)
      })
    }
  )

  server.tool("create_send_as",
    "Creates a custom send-as alias",
    {
      sendAsEmail: z.string().describe("The email address that appears in the 'From:' header"),
      displayName: z.string().optional().describe("A name that appears in the 'From:' header"),
      replyToAddress: z.string().optional().describe("An optional email address that is included in a 'Reply-To:' header"),
      signature: z.string().optional().describe("An optional HTML signature"),
      isPrimary: z.boolean().optional().describe("Whether this address is the primary address"),
      treatAsAlias: z.boolean().optional().describe("Whether Gmail should treat this address as an alias")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.sendAs.create({ userId: 'me', requestBody: params })
        return formatResponse(data)
      })
    }
  )

  server.tool("delete_send_as",
    "Deletes the specified send-as alias",
    {
      sendAsEmail: z.string().describe("The send-as alias to be deleted")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.sendAs.delete({ userId: 'me', sendAsEmail: params.sendAsEmail })
        return formatResponse(data)
      })
    }
  )

  server.tool("get_send_as",
    "Gets the specified send-as alias",
    {
      sendAsEmail: z.string().describe("The send-as alias to be retrieved")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.sendAs.get({ userId: 'me', sendAsEmail: params.sendAsEmail })
        return formatResponse(data)
      })
    }
  )

  server.tool("list_send_as",
    "Lists the send-as aliases for the specified account",
    {},
    async () => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.sendAs.list({ userId: 'me' })
        return formatResponse(data)
      })
    }
  )

  server.tool("patch_send_as",
    "Patches the specified send-as alias",
    {
      sendAsEmail: z.string().describe("The send-as alias to be updated"),
      displayName: z.string().optional().describe("A name that appears in the 'From:' header"),
      replyToAddress: z.string().optional().describe("An optional email address that is included in a 'Reply-To:' header"),
      signature: z.string().optional().describe("An optional HTML signature"),
      isPrimary: z.boolean().optional().describe("Whether this address is the primary address"),
      treatAsAlias: z.boolean().optional().describe("Whether Gmail should treat this address as an alias")
    },
    async (params) => {
      const { sendAsEmail, ...patchData } = params
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.sendAs.patch({ userId: 'me', sendAsEmail, requestBody: patchData })
        return formatResponse(data)
      })
    }
  )

  server.tool("update_send_as",
    "Updates a send-as alias",
    {
      sendAsEmail: z.string().describe("The send-as alias to be updated"),
      displayName: z.string().optional().describe("A name that appears in the 'From:' header"),
      replyToAddress: z.string().optional().describe("An optional email address that is included in a 'Reply-To:' header"),
      signature: z.string().optional().describe("An optional HTML signature"),
      isPrimary: z.boolean().optional().describe("Whether this address is the primary address"),
      treatAsAlias: z.boolean().optional().describe("Whether Gmail should treat this address as an alias")
    },
    async (params) => {
      const { sendAsEmail, ...updateData } = params
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.sendAs.update({ userId: 'me', sendAsEmail, requestBody: updateData })
        return formatResponse(data)
      })
    }
  )

  server.tool("verify_send_as",
    "Sends a verification email to the specified send-as alias",
    {
      sendAsEmail: z.string().describe("The send-as alias to be verified")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.sendAs.verify({ userId: 'me', sendAsEmail: params.sendAsEmail })
        return formatResponse(data)
      })
    }
  )

  server.tool("delete_smime_info",
    "Deletes the specified S/MIME config for the specified send-as alias",
    {
      sendAsEmail: z.string().describe("The email address that appears in the 'From:' header"),
      id: z.string().describe("The immutable ID for the S/MIME config")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.sendAs.smimeInfo.delete({ userId: 'me', sendAsEmail: params.sendAsEmail, id: params.id })
        return formatResponse(data)
      })
    }
  )

  server.tool("get_smime_info",
    "Gets the specified S/MIME config for the specified send-as alias",
    {
      sendAsEmail: z.string().describe("The email address that appears in the 'From:' header"),
      id: z.string().describe("The immutable ID for the S/MIME config")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.sendAs.smimeInfo.get({ userId: 'me', sendAsEmail: params.sendAsEmail, id: params.id })
        return formatResponse(data)
      })
    }
  )

  server.tool("insert_smime_info",
    "Insert (upload) the given S/MIME config for the specified send-as alias",
    {
      sendAsEmail: z.string().describe("The email address that appears in the 'From:' header"),
      encryptedKeyPassword: z.string().describe("Encrypted key password"),
      pkcs12: z.string().describe("PKCS#12 format containing a single private/public key pair and certificate chain")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.sendAs.smimeInfo.insert({ userId: 'me', sendAsEmail: params.sendAsEmail, requestBody: params })
        return formatResponse(data)
      })
    }
  )

  server.tool("list_smime_info",
    "Lists S/MIME configs for the specified send-as alias",
    {
      sendAsEmail: z.string().describe("The email address that appears in the 'From:' header")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.sendAs.smimeInfo.list({ userId: 'me', sendAsEmail: params.sendAsEmail })
        return formatResponse(data)
      })
    }
  )

  server.tool("set_default_smime_info",
    "Sets the default S/MIME config for the specified send-as alias",
    {
      sendAsEmail: z.string().describe("The email address that appears in the 'From:' header"),
      id: z.string().describe("The immutable ID for the S/MIME config")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.settings.sendAs.smimeInfo.setDefault({ userId: 'me', sendAsEmail: params.sendAsEmail, id: params.id })
        return formatResponse(data)
      })
    }
  )

  server.tool("get_profile",
    "Get the current user's Gmail profile",
    {},
    async () => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.getProfile({ userId: 'me' })
        return formatResponse(data)
      })
    }
  )

  server.tool("watch_mailbox",
    "Watch for changes to the user's mailbox",
    {
      topicName: z.string().describe("The name of the Cloud Pub/Sub topic to publish notifications to"),
      labelIds: z.array(z.string()).optional().describe("Label IDs to restrict notifications to"),
      labelFilterAction: z.enum(['include', 'exclude']).optional().describe("Whether to include or exclude the specified labels")
    },
    async (params) => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.watch({ userId: 'me', requestBody: params })
        return formatResponse(data)
      })
    }
  )

  server.tool("stop_mail_watch",
    "Stop receiving push notifications for the given user mailbox",
    {},
    async () => {
      return handleTool(config, async (gmail: gmail_v1.Gmail) => {
        const { data } = await gmail.users.stop({ userId: 'me' })
        return formatResponse(data)
      })
    }
  )

  return server.server
}

const main = async () => {
  fs.mkdirSync(MCP_CONFIG_DIR, { recursive: true })

  if (process.argv[2] === 'auth') {
    if (!defaultOAuth2Client) throw new Error('OAuth2 client could not be created, please check your credentials')
    await launchAuthServer(defaultOAuth2Client)
    process.exit(0)
  }

  // Stdio Server
  const stdioServer = createServer({})
  const transport = new StdioServerTransport()
  await stdioServer.connect(transport)

  // Streamable HTTP Server
  const { app } = createStatefulServer(createServer)
  app.listen(PORT)
}

main()
