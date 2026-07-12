# Voice and Speech

OpenACP supports two speech features: speech-to-text (STT) for voice input and text-to-speech (TTS) for spoken responses. Both are optional and configured independently.

## Speech-to-text (STT)

OpenACP ships with two native STT providers:

| Provider | Requirements | Notes |
|---|---|---|
| `local-whisper` | Python 3 plus `uv` or `python3-venv` | Runs locally with `faster-whisper`; no API key |
| `groq` | Groq API key | Hosted Whisper API |

`local-whisper` is the recommended private/offline option. On its first transcription, OpenACP creates a virtual environment, installs `faster-whisper`, and downloads the selected model. Later requests reuse the environment and model cache. The maintained package also reuses the former wrapper cache at `~/.cache/codex/transcribe-voice`, so upgrading does not redownload an existing model.

When STT is configured, you can send voice messages to a session topic and OpenACP transcribes them before passing the text to the agent. The transcribed text appears in the topic as a system message:

```
You said: "Add a unit test for the login function"
```

The agent then receives the transcription as a normal text prompt. If the agent natively supports audio input, the audio attachment is passed directly instead.

**Supported audio formats:** OGG, WAV, MP3, M4A, WebM, FLAC (maximum 25 MB per file).

### Configuring STT

Use `/settings` in Telegram or the plugin settings API and select `local-whisper`. The equivalent persisted settings for the built-in `@openacp/speech` plugin are:

```json
{
  "sttProvider": "local-whisper",
  "localWhisperLanguage": "ru",
  "localWhisperModel": "base",
  "localWhisperBeamSize": 5,
  "localWhisperVadFilter": false,
  "localWhisperDevice": "cpu",
  "localWhisperComputeType": "int8",
  "localWhisperTimeoutMs": 120000
}
```

For Groq, select `groq` and set `groqApiKey`. The older behavior remains compatible: when a Groq key exists and `sttProvider` is unset, OpenACP activates Groq automatically.

Advanced installations can set `localWhisperScriptPath` to a custom executable. Leave it unset to use the runtime bundled in `@n1creator/openacp-cli`.

### STT error handling

If transcription fails, the audio attachment is kept and passed to the agent as-is, with an error message in the topic. For local STT, check that Python can create virtual environments and that the first-run dependency/model download has network access. For Groq, check the API key, rate limit, and network access.

## Text-to-speech (TTS)

**Provider:** Edge TTS (Microsoft's neural TTS service)
**Cost:** Free, no API key required
**Default voice:** `en-US-AriaNeural`
**Output format:** MP3 (24 kHz, 48 kbps mono)

When TTS is active for a session, the agent is instructed to include a spoken-friendly summary of its response in a `[TTS]...[/TTS]` block. OpenACP extracts this block, synthesizes audio, and sends it back to the chat as a voice message. TTS synthesis has a 30-second timeout — if it exceeds this, the audio is skipped silently.

The agent decides what to include in the TTS block. It focuses on key information, decisions the user needs to make, or required actions. The response language matches whatever language you are using.

### Voice modes

TTS operates in one of three modes per session:

| Mode | Behavior |
|---|---|
| `off` | No TTS (default) |
| `next` | TTS for the next message only, then reverts to `off` |
| `on` | TTS for every subsequent message |

### Toggling TTS

**Telegram — in a session topic:**
```
/text_to_speech        # next message only
/text_to_speech on     # persistent
/text_to_speech off    # disable
```

**Via the session control keyboard:** Tap the "Text to Speech" toggle button in the session setup message.

**Discord:**
```
/tts             # next message only
/tts on          # persistent
/tts off         # disable
```

### Configuring TTS

Edge TTS works out of the box with no configuration. To change the voice, update your config:

```json
{
  "speech": {
    "tts": {
      "provider": "edge-tts",
      "voice": "en-GB-SoniaNeural"
    }
  }
}
```

Microsoft Edge TTS supports a large number of voices across many languages. Voice names follow the pattern `{language}-{region}-{name}Neural`.

### Enabling TTS in config

```json
{
  "speech": {
    "tts": {
      "provider": "edge-tts"
    }
  }
}
```

Set `provider` to `null` to disable TTS entirely.

## Using both together

STT and TTS work independently. You can use either or both at the same time. A typical voice workflow:

1. Send a voice message in a session topic
2. OpenACP transcribes it via local Whisper or Groq STT
3. The transcription appears as "You said: ..."
4. The agent processes the text and responds
5. If TTS is on, the response summary is synthesized and sent as audio
