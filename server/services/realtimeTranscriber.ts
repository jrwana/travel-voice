import WebSocket from "ws";

export interface TranscriberCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onSpeechStarted: () => void;
  onError: (message: string) => void;
}

export class RealtimeTranscriber {
  private socket?: WebSocket;
  private partials = new Map<string, string>();

  constructor(
    private readonly apiKey: string,
    private readonly safetyIdentifier: string,
    private readonly callbacks: TranscriberCallbacks,
  ) {}

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    // A transcription-only session: the model goes in audio.input.transcription, not the URL
    // (the URL model is the realtime conversation model). Server VAD ends each caller turn and
    // emits the speech_started / completed events handled below.
    const model = process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-4o-mini-transcribe";
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Safety-Identifier": this.safetyIdentifier,
        },
      });
      this.socket = socket;
      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            type: "session.update",
            session: {
              type: "transcription",
              audio: {
                input: {
                  format: { type: "audio/pcm", rate: 24_000 },
                  transcription: {
                    model,
                    prompt:
                      "Fictional premium travel support call for Meridian and Pine. Confirmation codes begin MPT, " +
                      "followed by four digits (MPT-4821, MPT-7315). Hotels: The Lume, Aoki House.",
                    language: "en",
                  },
                  turn_detection: {
                    type: "server_vad",
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 650,
                  },
                },
              },
            },
          }),
        );
        resolve();
      });
      socket.on("message", (raw) => this.handleMessage(raw.toString()));
      socket.once("error", (error) => {
        this.callbacks.onError(error.message);
        reject(error);
      });
      socket.on("close", (code) => {
        if (code !== 1000) this.callbacks.onError(`Realtime transcription closed with code ${code}.`);
      });
    });
  }

  append(base64Pcm16: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64Pcm16 }));
  }

  close(): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close(1000);
    this.socket = undefined;
    this.partials.clear();
  }

  private handleMessage(raw: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(event.type ?? "");
    const itemId = String(event.item_id ?? "active");
    if (type === "input_audio_buffer.speech_started") {
      this.callbacks.onSpeechStarted();
      return;
    }
    if (type === "conversation.item.input_audio_transcription.delta") {
      const partial = `${this.partials.get(itemId) ?? ""}${String(event.delta ?? "")}`;
      this.partials.set(itemId, partial);
      this.callbacks.onPartial(partial);
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const transcript = String(event.transcript ?? this.partials.get(itemId) ?? "").trim();
      this.partials.delete(itemId);
      if (transcript) this.callbacks.onFinal(transcript);
      return;
    }
    if (type === "error") {
      const detail = event.error as { message?: string } | undefined;
      this.callbacks.onError(detail?.message ?? "Realtime transcription returned an error.");
    }
  }
}
