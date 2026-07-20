# Files and Media

You can send files, images, and audio directly to an active session. The agent receives them as attachments alongside your text message.

## Sending files

In a session topic or thread, attach a file to your message the same way you would in any other chat. OpenACP detects the attachment, saves it, and includes it in the prompt sent to the agent.

You can combine text and files in a single message:

```
Here is the screenshot of the error — can you explain what went wrong?
[attach: screenshot.png]
```

If you send an attachment without text, OpenACP still forwards it to the agent.

## Supported types

| Type | Formats |
|---|---|
| Images | JPEG, PNG, GIF, WebP, SVG |
| Audio | OGG, MP3, WAV, M4A, WebM |
| Video | MP4, WebM |
| Documents | PDF, plain text (.txt) |
| Other | Any file type — passed as a generic attachment |

Images and audio are classified automatically. Everything else is treated as a generic file attachment.

## How it works

When you send a file, OpenACP:

1. Downloads the file from the messaging platform
2. Saves it to `~/.openacp/files/{sessionId}/` with a timestamp prefix
3. Constructs an `Attachment` object with the file path, MIME type, and size
4. Includes the attachment in the prompt sent to the agent via ACP

The agent receives the file path and can read the file from disk. Files persist for the lifetime of the session.

### Audio attachments and STT

If you send an audio file (including Telegram voice messages) and STT is configured, OpenACP transcribes the audio and sends the text to the agent instead of the raw file. See [Voice and Speech](voice-and-speech.md) for details.

If the agent natively supports audio input, the audio is passed directly without transcription.

Telegram voice messages are in OGG Opus format. OpenACP can convert them to WAV for agents that cannot read OGG directly.

## Acknowledged delivery from local automation

A local automation client can send a host file back to the exact current
session through OpenACP's acknowledged attachment API. This is an outbound flow;
it is separate from attaching a file to an incoming chat message.

1. Call `POST /api/v1/attachment-delivery/v1/resolve` with an explicit OpenACP
   session ID, or the exact agent session ID when no explicit session is known.
2. Keep the returned opaque `target` unchanged.
3. Call `POST /api/v1/attachment-delivery/v1/deliver` with the target, metadata,
   and file in one multipart request.
4. Treat the operation as successful only when the response is
   `provider_accepted` and contains `providerMessageId`.

All three attachment-delivery endpoints, including health, require an API
credential with `attachments:send` and a direct loopback connection. They reject
forwarding headers and external Host values, so they are not available through
OpenACP tunnels or reverse proxies. The built-in operator role includes the
scope; viewer tokens do not.

The target is a short-lived, secret-free routing proof. It contains no provider
token, proxy setting, chat/topic ID, or local file path. An explicit session is
never replaced by a fallback session: a missing, mismatched, archiving,
terminated, or rebound explicit target fails. Without an explicit session,
OpenACP requires exactly one deliverable current match for the supplied agent
session ID; zero or multiple matches return `target_unavailable`. It does not
choose the newest or most active session. Routing and the adapter/topic lease
are checked again after file staging and immediately before provider I/O.
The proof also binds the current agent generation, so replacing the agent
invalidates an earlier target even when the new process reuses the same
agent-session ID. A daemon restart invalidates an uncommitted target; resolve a
new target before a new delivery.

The adapter must support both file upload and acknowledged delivery and must be
operational. If it is unavailable during resolve, or becomes unavailable before
staging or while queued for provider I/O, OpenACP returns retryable
`provider_unavailable` and does not send the file.

OpenACP validates the filename, MIME type, declared byte size, and lowercase
SHA-256 digest before staging the bytes through the host file service. The
default API limit is 50 MiB; the active value is returned by the health endpoint.
The multipart `file` filename, MIME type, and size must exactly match the
`metadata` field. Filenames may be at most 255 characters and cannot be `.`,
`..`, contain path separators, NUL, or control characters.

Receipts are journaled after provider acceptance. A retry with the same target,
`deliveryId`, and SHA-256 returns the committed receipt without another send,
including after an OpenACP restart; reusing the ID for different content or a
different binding target within the same session and adapter returns
`delivery_id_conflict`. Telegram receipts expose the real Bot API `message_id`
as `providerMessageId`. Telegram does not accept a caller-supplied idempotency
key, so a process crash after Telegram accepts the document but before OpenACP
commits the receipt remains ambiguous and a retry can duplicate that one
delivery.

After restart, retrieve an already committed receipt by retrying the original
target, delivery ID, and hash. A newly resolved target has a different binding.

See [Acknowledged attachment delivery](../api-reference/rest-api.md#acknowledged-attachment-delivery)
for exact payloads, responses, and error codes.

## File viewer via tunnel

When an agent produces output files — generated images, edited documents, reports — you can view them through the tunnel feature. Use `/tunnel 3000` (or whichever port) to expose a local web server with a public URL.

OpenACP's tunnel integration supports Monaco editor for code files and inline image preview.

See [Chat Commands — /tunnel](chat-commands.md#tunnel-port-label-telegram-only) for how to create and manage tunnels.

## Size limits

Platform-imposed limits apply before OpenACP processes the file:

| Platform | Limit |
|---|---|
| Telegram | 20 MB for bots (standard API) |
| Discord | 8 MB (free), 50 MB (Nitro) |

For audio transcription via Groq STT, the additional limit is 25 MB per file.

The acknowledged local delivery API has its own default 50 MiB limit. The
destination provider can impose a lower limit or reject the file or MIME type.

Files that exceed the platform limit are never delivered to OpenACP. If you need to share large files, point the agent at a path on the server's local filesystem in your message text instead.
