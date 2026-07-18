import { describe, it, expect, vi, beforeEach } from "vitest";
import { Session } from "../session.js";
import type { AgentInstance } from "../../agents/agent-instance.js";
import type { SpeechService } from "../../../plugins/speech/exports.js";
import { TypedEmitter } from "../../utils/typed-emitter.js";
import { Hook } from "../../events.js";

vi.mock("node:fs", () => ({
  promises: {
    readFile: vi.fn().mockResolvedValue(Buffer.from("fake audio data")),
  },
}));

function mockAgent(hasAudio = false): AgentInstance {
  const emitter = new TypedEmitter();
  return Object.assign(emitter, {
    sessionId: "test-session",
    promptCapabilities: hasAudio ? { audio: true } : {},
    prompt: vi.fn().mockResolvedValue({}),
    cancel: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
  }) as any;
}

function mockSpeechService(available: boolean, transcribeResult?: string): SpeechService {
  return {
    isSTTAvailable: () => available,
    transcribe: vi.fn().mockResolvedValue({ text: transcribeResult || "transcribed text" }),
  } as any;
}

describe("Session speech integration", () => {
  it("transcribes audio when agent lacks audio capability and STT is available", async () => {
    const agent = mockAgent(false);
    const speech = mockSpeechService(true, "hello from voice");

    const session = new Session({
      channelId: "test",
      agentName: "test-agent",
      workingDirectory: "/tmp",
      agentInstance: agent,
      speechService: speech,
    });

    await session.enqueuePrompt("", [{
      type: "audio",
      filePath: "/tmp/voice.ogg",
      fileName: "voice.ogg",
      mimeType: "audio/ogg",
      size: 1000,
    }]);

    await vi.waitFor(() => {
      expect(agent.prompt).toHaveBeenCalled();
    });

    const [text, attachments] = (agent.prompt as any).mock.calls[0];
    expect(text).toContain("hello from voice");
    expect(attachments?.some((a: any) => a.type === "audio")).toBeFalsy();
  });

  it("passes audio through when agent supports audio", async () => {
    const agent = mockAgent(true);
    const speech = mockSpeechService(true);

    const session = new Session({
      channelId: "test",
      agentName: "test-agent",
      workingDirectory: "/tmp",
      agentInstance: agent,
      speechService: speech,
    });

    await session.enqueuePrompt("check this", [{
      type: "audio",
      filePath: "/tmp/voice.ogg",
      fileName: "voice.ogg",
      mimeType: "audio/ogg",
      size: 1000,
    }]);

    await vi.waitFor(() => {
      expect(agent.prompt).toHaveBeenCalled();
    });

    const [text, attachments] = (agent.prompt as any).mock.calls[0];
    expect(text).toBe("check this");
    expect(attachments).toHaveLength(1);
    expect(attachments[0].type).toBe("audio");
    expect(speech.transcribe).not.toHaveBeenCalled();
  });

  it("falls back gracefully when STT not configured", async () => {
    const agent = mockAgent(false);
    const speech = mockSpeechService(false);

    const session = new Session({
      channelId: "test",
      agentName: "test-agent",
      workingDirectory: "/tmp",
      agentInstance: agent,
      speechService: speech,
    });

    await session.enqueuePrompt("[Audio: voice.ogg]", [{
      type: "audio",
      filePath: "/tmp/voice.ogg",
      fileName: "voice.ogg",
      mimeType: "audio/ogg",
      size: 1000,
    }]);

    await vi.waitFor(() => {
      expect(agent.prompt).toHaveBeenCalled();
    });

    const [, attachments] = (agent.prompt as any).mock.calls[0];
    expect(attachments).toHaveLength(1);
  });

  it("emits a nonfatal warning and keeps attachment when transcription fails", async () => {
    const agent = mockAgent(false);
    const speech = {
      isSTTAvailable: () => true,
      transcribe: vi.fn().mockRejectedValue(new Error("Groq rate limit exceeded")),
    } as any;

    const session = new Session({
      channelId: "test",
      agentName: "test-agent",
      workingDirectory: "/tmp",
      agentInstance: agent,
      speechService: speech,
    });

    const warningEvents: any[] = [];
    session.on("agent_event", (e) => { if (e.type === "system_message") warningEvents.push(e); });

    await session.enqueuePrompt("[Audio: voice.ogg]", [{
      type: "audio",
      filePath: "/tmp/voice.ogg",
      fileName: "voice.ogg",
      mimeType: "audio/ogg",
      size: 1000,
    }]);

    await vi.waitFor(() => {
      expect(agent.prompt).toHaveBeenCalled();
    });

    const [, attachments] = (agent.prompt as any).mock.calls[0];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].type).toBe("audio");
    expect(warningEvents).toHaveLength(1);
    expect(warningEvents[0].message).toContain("Groq rate limit exceeded");
    expect(session.status).toBe('active');
  });

  it('preserves the timeout summary while bounding and redacting transcription diagnostics', async () => {
    const agent = mockAgent(false);
    const timeoutSummary = 'Transcription timed out after 600 seconds. Retry the voice message or check proxy access. Details:';
    const speech = {
      isSTTAvailable: () => true,
      transcribe: vi.fn().mockRejectedValue(new Error(
        `${timeoutSummary} ${'&'.repeat(5_000)} https://user:secret@example.test`,
      )),
    } as any;
    const session = new Session({
      channelId: 'test', agentName: 'test-agent', workingDirectory: '/tmp',
      agentInstance: agent, speechService: speech,
    });
    const warnings: any[] = [];
    session.on('agent_event', (event) => {
      if (event.type === 'system_message') warnings.push(event);
    });

    await session.enqueuePrompt('[Audio: voice.ogg]', [{
      type: 'audio', filePath: '/tmp/voice.ogg', fileName: 'voice.ogg', mimeType: 'audio/ogg', size: 1000,
    }]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain(timeoutSummary);
    expect(warnings[0].message).toContain('[middle output truncated]');
    expect(warnings[0].message).not.toContain('secret');
    expect(warnings[0].message.length).toBeLessThan(850);
  });

  it('starts the turn lifecycle before local speech preprocessing', async () => {
    const agent = mockAgent(false);
    let finishTranscription!: () => void;
    const transcriptionPending = new Promise<void>((resolve) => { finishTranscription = resolve; });
    const speech = {
      isSTTAvailable: () => true,
      transcribe: vi.fn(async () => {
        await transcriptionPending;
        return { text: 'hello from voice' };
      }),
    } as any;
    const middleware = {
      execute: vi.fn(async (_hook: Hook, payload: unknown, next: (value: unknown) => Promise<unknown>) => next(payload)),
    } as any;
    const session = new Session({
      channelId: 'test', agentName: 'test-agent', workingDirectory: '/tmp',
      agentInstance: agent, speechService: speech,
    });
    session.name = 'skip-auto-name';
    session.middlewareChain = middleware;

    const pending = session.enqueuePrompt('[Audio: voice.ogg]', [{
      type: 'audio', filePath: '/tmp/voice.ogg', fileName: 'voice.ogg', mimeType: 'audio/ogg', size: 1000,
    }]);
    await vi.waitFor(() => expect(speech.transcribe).toHaveBeenCalledOnce());

    const turnStart = middleware.execute.mock.calls.find(([hook]: [Hook]) => hook === Hook.TURN_START);
    expect(turnStart?.[1]).toEqual(expect.objectContaining({ promptText: '[Audio: voice.ogg]' }));
    expect(agent.prompt).not.toHaveBeenCalled();

    finishTranscription();
    await pending;
    expect(agent.prompt).toHaveBeenCalledWith(expect.stringContaining('hello from voice'), undefined);
  });

  it('cancels STT before agent prompt and drains the next prompt only after cleanup', async () => {
    const agent = mockAgent(false);
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    let receivedSignal: AbortSignal | undefined;
    const speech = {
      isSTTAvailable: () => true,
      transcribe: vi.fn(async (_audio: Buffer, _mime: string, options?: { signal?: AbortSignal }) => {
        receivedSignal = options?.signal;
        await new Promise<void>((resolve) => receivedSignal!.addEventListener('abort', resolve, { once: true }));
        await cleanup;
        throw receivedSignal!.reason;
      }),
    } as any;
    const session = new Session({
      channelId: 'test', agentName: 'test-agent', workingDirectory: '/tmp',
      agentInstance: agent, speechService: speech,
    });
    session.name = 'skip-auto-name';
    const events: any[] = [];
    session.on('agent_event', (event) => events.push(event));

    const first = session.enqueuePrompt('[Audio: voice.ogg]', [{
      type: 'audio', filePath: '/tmp/voice.ogg', fileName: 'voice.ogg', mimeType: 'audio/ogg', size: 1000,
    }]);
    await vi.waitFor(() => expect(speech.transcribe).toHaveBeenCalledOnce());
    const second = session.enqueuePrompt('second');
    const cancel = session.abortPrompt();
    await vi.waitFor(() => expect(receivedSignal?.aborted).toBe(true));
    expect(agent.prompt).not.toHaveBeenCalled();

    finishCleanup();
    await cancel;
    await Promise.all([first, second]);
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    expect(agent.prompt).toHaveBeenCalledWith('second', undefined);
    expect(events.some((event) => event.type === 'error' || (event.type === 'system_message' && event.message.includes('transcription failed')))).toBe(false);
    expect(session.status).toBe('active');
  });

  it('waits for STT cleanup before destroying the agent', async () => {
    const agent = mockAgent(false);
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    let receivedSignal: AbortSignal | undefined;
    const speech = {
      isSTTAvailable: () => true,
      transcribe: vi.fn(async (_audio: Buffer, _mime: string, options?: { signal?: AbortSignal }) => {
        receivedSignal = options?.signal;
        await new Promise<void>((resolve) => receivedSignal!.addEventListener('abort', resolve, { once: true }));
        await cleanup;
        throw receivedSignal!.reason;
      }),
    } as any;
    const session = new Session({
      channelId: 'test', agentName: 'test-agent', workingDirectory: '/tmp',
      agentInstance: agent, speechService: speech,
    });
    session.name = 'skip-auto-name';

    const prompt = session.enqueuePrompt('[Audio: voice.ogg]', [{
      type: 'audio', filePath: '/tmp/voice.ogg', fileName: 'voice.ogg', mimeType: 'audio/ogg', size: 1000,
    }]);
    await vi.waitFor(() => expect(speech.transcribe).toHaveBeenCalledOnce());

    const destroying = session.destroy();
    await vi.waitFor(() => expect(receivedSignal?.aborted).toBe(true));
    expect(agent.destroy).not.toHaveBeenCalled();

    finishCleanup();
    await Promise.all([prompt, destroying]);
    expect(agent.destroy).toHaveBeenCalledOnce();
  });

  it("works without speechService (backward compat)", async () => {
    const agent = mockAgent(false);

    const session = new Session({
      channelId: "test",
      agentName: "test-agent",
      workingDirectory: "/tmp",
      agentInstance: agent,
    });

    await session.enqueuePrompt("hello", [{
      type: "audio",
      filePath: "/tmp/voice.ogg",
      fileName: "voice.ogg",
      mimeType: "audio/ogg",
      size: 1000,
    }]);

    await vi.waitFor(() => {
      expect(agent.prompt).toHaveBeenCalled();
    });

    const [, attachments] = (agent.prompt as any).mock.calls[0];
    expect(attachments).toHaveLength(1);
  });
});
