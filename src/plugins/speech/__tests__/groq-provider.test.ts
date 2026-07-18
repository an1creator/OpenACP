import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GroqSTT } from "../providers/groq.js";

describe("GroqSTT", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends correct request to Groq API", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: "hello world" }),
    });

    const provider = new GroqSTT("gsk_test123", "whisper-large-v3-turbo");
    const result = await provider.transcribe(
      Buffer.from("fake-audio"), "audio/ogg",
    );

    expect(result.text).toBe("hello world");
    const call = (global.fetch as any).mock.calls[0];
    expect(call[0]).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    const opts = call[1];
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer gsk_test123");
    expect(opts.body).toBeInstanceOf(FormData);
  });

  it('uses the injected speech-download transport instead of global fetch', async () => {
    const scoped = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'scoped' }) })
    const forbidden = vi.fn().mockRejectedValue(new Error('global fetch used'))
    global.fetch = forbidden
    const provider = new GroqSTT('gsk_test', 'whisper-large-v3-turbo', scoped as typeof fetch)
    await expect(provider.transcribe(Buffer.from('audio'), 'audio/ogg')).resolves.toMatchObject({ text: 'scoped' })
    expect(scoped).toHaveBeenCalledOnce(); expect(forbidden).not.toHaveBeenCalled()
  })

  it('resolves the scoped fetch again for every transcription after route rotation', async () => {
    const oldFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'old' }) })
    const newFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'new' }) })
    let current = oldFetch as typeof fetch
    const provider = new GroqSTT('gsk_test', 'whisper-large-v3-turbo', current, () => current)
    await expect(provider.transcribe(Buffer.from('one'), 'audio/ogg')).resolves.toMatchObject({ text: 'old' })
    current = newFetch as typeof fetch
    await expect(provider.transcribe(Buffer.from('two'), 'audio/ogg')).resolves.toMatchObject({ text: 'new' })
    expect(oldFetch).toHaveBeenCalledOnce(); expect(newFetch).toHaveBeenCalledOnce()
  })

  it("passes language option when provided", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: "xin chao" }),
    });

    const provider = new GroqSTT("gsk_test", "whisper-large-v3-turbo");
    await provider.transcribe(Buffer.from("audio"), "audio/ogg", { language: "vi" });

    const body = (global.fetch as any).mock.calls[0][1].body as FormData;
    expect(body.get("language")).toBe("vi");
  });

  it('passes prompt cancellation to the scoped fetch', async () => {
    const scoped = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'done' }) })
    const controller = new AbortController()
    const provider = new GroqSTT('gsk_test', undefined, scoped as typeof fetch)
    await provider.transcribe(Buffer.from('audio'), 'audio/ogg', { signal: controller.signal })
    expect(scoped).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }))
  })

  it("throws on 401 with helpful message", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });

    const provider = new GroqSTT("bad_key", "whisper-large-v3-turbo");
    await expect(provider.transcribe(Buffer.from("audio"), "audio/ogg"))
      .rejects.toThrow(/invalid.*api.*key/i);
  });

  it('checks candidate access without uploading audio or returning provider bodies', async () => {
    const scoped = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('secret provider response', { status: 401 }))
    const provider = new GroqSTT('gsk_candidate', undefined, scoped as typeof fetch)
    await expect(provider.checkAccess()).resolves.toEqual({ ok: true, status: 200, message: 'Groq accepted the API key.' })
    const rejected = await provider.checkAccess()
    expect(rejected).toEqual({ ok: false, status: 401, message: 'Groq rejected the API key.' })
    expect(JSON.stringify(rejected)).not.toContain('secret provider response')
    expect(scoped).toHaveBeenCalledWith('https://api.groq.com/openai/v1/models', expect.objectContaining({ method: 'GET' }))
    expect(scoped.mock.calls.every(([, init]) => init.body === undefined)).toBe(true)
  });

  it("throws on 429 with rate limit message", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve("Rate limited"),
    });

    const provider = new GroqSTT("gsk_test", "whisper-large-v3-turbo");
    await expect(provider.transcribe(Buffer.from("audio"), "audio/ogg"))
      .rejects.toThrow(/rate limit/i);
  });

  it("throws on 413 with file too large message", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 413,
      text: () => Promise.resolve("Payload too large"),
    });

    const provider = new GroqSTT("gsk_test", "whisper-large-v3-turbo");
    await expect(provider.transcribe(Buffer.from("audio"), "audio/ogg"))
      .rejects.toThrow(/too large/i);
  });

  it("uses model override from options", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: "test" }),
    });

    const provider = new GroqSTT("gsk_test", "whisper-large-v3-turbo");
    await provider.transcribe(Buffer.from("audio"), "audio/ogg", { model: "whisper-large-v3" });

    const body = (global.fetch as any).mock.calls[0][1].body as FormData;
    expect(body.get("model")).toBe("whisper-large-v3");
  });
});
