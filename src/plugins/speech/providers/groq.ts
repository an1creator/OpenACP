import type { STTProvider, STTOptions, STTResult } from '../speech-types.js';

// Groq's Whisper-compatible transcription endpoint (OpenAI-compatible API)
const GROQ_API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";

export interface GroqAccessCheck {
  ok: boolean;
  status?: number;
  message: string;
}

/**
 * Speech-to-text provider backed by Groq's hosted Whisper API.
 *
 * Groq requires the audio to be submitted as a multipart form upload. The file
 * must have a valid extension matching its MIME type — Groq uses the extension
 * to determine the codec, so a mismatch causes a transcription error.
 *
 * Free tier limit: 28,800 seconds of audio per day. Max file size: 25 MB.
 */
export class GroqSTT implements STTProvider {
  readonly name = "groq";

  constructor(
    private apiKey: string,
    private defaultModel: string = "whisper-large-v3-turbo",
    private scopedFetch: typeof fetch = globalThis.fetch,
    private getScopedFetch?: () => typeof fetch,
    private endpoint = GROQ_API_URL,
    private accessEndpoint = GROQ_MODELS_URL,
  ) {}

  /** Validate credentials without sending audio or exposing a provider response body. */
  async checkAccess(signal?: AbortSignal): Promise<GroqAccessCheck> {
    let response: Response;
    try {
      response = await (this.getScopedFetch?.() ?? this.scopedFetch)(this.accessEndpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal,
      });
    } catch {
      return { ok: false, message: "Could not reach Groq through the configured speech route." };
    }
    try { await response.body?.cancel(); } catch { /* access checks never inspect provider bodies */ }
    if (response.ok) return { ok: true, status: response.status, message: "Groq accepted the API key." };
    if (response.status === 401) return { ok: false, status: 401, message: "Groq rejected the API key." };
    if (response.status === 403) return { ok: false, status: 403, message: "The API key does not have access to Groq transcription." };
    if (response.status === 429) return { ok: false, status: 429, message: "Groq temporarily rate-limited the access check. Try again later." };
    return { ok: false, status: response.status, message: `Groq access check failed (HTTP ${response.status}).` };
  }

  /**
   * Transcribes audio using the Groq Whisper API.
   *
   * `verbose_json` response format is requested so the API returns language
   * detection and duration metadata alongside the transcript text.
   */
  async transcribe(audioBuffer: Buffer, mimeType: string, options?: STTOptions): Promise<STTResult> {
    const ext = mimeToExt(mimeType);
    const form = new FormData();
    // Groq uses the filename extension to identify the audio codec — must match mimeType
    form.append("file", new Blob([new Uint8Array(audioBuffer)], { type: mimeType }), `audio${ext}`);
    form.append("model", options?.model || this.defaultModel);
    form.append("response_format", "verbose_json");
    if (options?.language) {
      form.append("language", options.language);
    }

    const resp = await (this.getScopedFetch?.() ?? this.scopedFetch)(this.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: options?.signal,
    });

    if (!resp.ok) {
      try { await resp.body?.cancel(); } catch { /* release failed response without reading provider text */ }
      if (resp.status === 401) {
        throw new Error("Invalid Groq API key. Check your key at console.groq.com.");
      }
      if (resp.status === 413) {
        throw new Error("Audio file too large for Groq API (max 25MB).");
      }
      if (resp.status === 429) {
        throw new Error("Groq rate limit exceeded. Free tier: 28,800 seconds/day. Try again later.");
      }
      throw new Error(`Groq transcription failed (HTTP ${resp.status}). Check Groq status and run /speech → Check setup.`);
    }

    const data = await resp.json() as { text: string; language?: string; duration?: number };
    return {
      text: data.text,
      language: data.language,
      duration: data.duration,
    };
  }
}

/** Maps MIME types to file extensions required by the Groq upload API. */
function mimeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/webm": ".webm",
    "audio/flac": ".flac",
  };
  return map[mimeType] || ".bin";
}
