# Sessions

A session is an isolated conversation between you and an AI agent. Each session has its own context window, working directory, and state. On Telegram, sessions get their own forum topic. On Discord, sessions get their own thread.

## Creating a session

Use `/new` to start a session:

```
/new                           # interactive — choose agent and workspace
/new claude ~/code/my-project  # create directly
```

If you have multiple agents installed, an inline keyboard lets you pick one. You then choose or type a workspace directory — the folder the agent will read, write, and run code in.

## Session lifecycle

A session goes through several stages during its life:

1. **Starting up** — The session is being created and the AI agent is warming up. This usually takes a few seconds.
2. **Active** — The session is ready. You can send messages and the agent will respond. This is where you spend most of your time.
3. **Done** — The agent finished its work. OpenACP delivers the final connector
   message, releases the ACP process and live bridge resources, and keeps the
   durable session record. The topic stays open for reference and lazy resume.

Sometimes things go differently:

- **Error** — Something went wrong, but you can usually recover by sending another message. OpenACP will try to reconnect the agent automatically.
- **Cancelled** — You stopped the session with `/cancel`. The session topic stays open and you can start a new one.

Use `/status` inside a session topic to see the current state.

## Auto-naming

After you send your first message, OpenACP silently asks the agent to generate a title of at most 5 words and 50 characters. The session topic or thread is renamed automatically. You never see this internal prompt — it runs in the background and does not affect your conversation.

New names are normalized to one line in core before they reach Telegram, Discord, Slack, REST, or SSE. Manual names set through the authenticated API may contain up to 200 characters and have priority even when automatic naming is already in progress. Stored session names are restored as written. An agent metadata update that merely repeats the current user prompt is ignored, so it cannot replace auto-naming or appear as a session update.

If naming fails, the session falls back to `Session <id>`.

## Concurrent sessions

You can run multiple sessions at the same time. The default limit is 20 concurrent active sessions. This is configurable via `maxConcurrentSessions` in your config file.

If the limit is reached, `/new` returns an error message. Cancel or finish an existing session to free a slot.

OpenACP reserves capacity before it starts an ACP process. Concurrent creates
and lazy resumes across chat, REST, and SSE cannot exceed the configured limit.
The limit applies to new live sessions, not to additional prompts in a session
that already owns a slot. A session releases its slot when it enters `error`.
Sending another prompt to that live errored session atomically reacquires a slot
before the prompt is queued or the session returns to `active`; if the current
limit is full, the prompt is rejected and the session remains in `error`.

## Session timeout

Sessions have an inactivity timeout (default: 60 minutes). If no prompt is sent within the timeout period, the session is automatically cancelled. The timeout is configurable.

## Resuming sessions

Sessions that are `finished` or have been idle since a restart can often be resumed by simply sending a message in the existing topic or thread. Finished sessions do not keep an idle ACP process running; OpenACP uses the durable record to reconnect or recreate the agent session when the next message arrives.

Sessions that went offline (e.g., after a server restart) are automatically resumed when you send a message to their topic. This happens transparently — you do not need to manually restart the session.

For richer resume with full conversation history, use `/resume` (Telegram only). This loads context from Entire checkpoints or OpenACP's built-in history recorder — previous sessions' work is injected into the new session's context window. See the `/resume` section in [Chat Commands](chat-commands.md) for query formats.

## Session settings

Some agents let you change settings mid-conversation — like switching between different modes or models:

```
/mode                          # show available modes (e.g., code, architect)
/model                         # show available models
/thought                       # toggle thinking/reasoning mode
/dangerous                     # toggle bypass permissions
```

Available options depend on the agent you are using. When an agent updates its available options, the session reflects the changes automatically.

OpenACP restores saved agent options only after the resumed agent acknowledges
the change. If an option is no longer supported or the agent rejects it, the
live value remains authoritative and is saved for the next resume.

## Structured input requests

An ACP agent can pause a turn and request a small form. Telegram presents each
field in the session topic; REST/SSE clients receive the same request as a
structured event. Required fields and string, number, integer, boolean, select,
and multi-select constraints are validated before the response reaches the
agent.

Every REST response is bound to the principal that started the turn. The same
JWT, another JWT linked to the same canonical user, or the master API secret can
answer; an unrelated JWT cannot accept, decline, or cancel the request.
Telegram removes a protected reply before accepting it; if deletion
fails, OpenACP cancels the request and does not use the value. Standard ACP form
fields are not treated as secret input. Protected fields are available only for
the Codex ACP extension and require Telegram's delete-after-capture flow or an
authenticated HTTPS/loopback REST request.

String `pattern` constraints are rejected. OpenACP does not execute
agent-supplied JavaScript regular expressions on its event loop; use enumerated
choices, length bounds, or one of the supported string formats instead.

Requests expire, are cancelled with their turn, and accept only the first
response. Submitted values are transient: OpenACP returns them to the requesting
agent but does not place them in session history, SSE resolution events, or
logs. Adapters without a form UI show an authenticated REST fallback for
non-sensitive requests; protected connector requests fail closed instead of
falling back to an unsafe chat message.

## Cancelling a prompt

`/cancel` inside a session topic aborts the running prompt and clears the queue. The session stays in `active` state — you can send another message immediately.

This does not end the session. If you want to permanently stop a session and remove its topic, use `/archive`.

## Starting a new chat in the same session

`/newchat` creates a fresh conversation window with the same agent and workspace, without going through the full setup flow. Run it inside an existing session topic. A new topic is created and a link is posted in the original topic.

## Viewing all sessions

Use `/sessions` to list every session with its status emoji:

- Green circle — active
- Yellow circle — initializing
- Check mark — finished
- Red X — error
- Stop sign — cancelled

On Telegram, cleanup buttons let you bulk-remove finished, errored, or all sessions from the list and their topics from the group.
