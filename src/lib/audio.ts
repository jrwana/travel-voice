export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

export class MicrophoneCapture {
  private context?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private mute?: GainNode;

  async start(onChunk: (base64Pcm16: string) => void): Promise<void> {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.context = new AudioContext({ sampleRate: 48_000 });
    await this.context.audioWorklet.addModule("/pcm-processor.js");
    this.source = this.context.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.context, "pcm-capture");
    this.mute = this.context.createGain();
    this.mute.gain.value = 0;
    this.worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => onChunk(arrayBufferToBase64(event.data));
    this.source.connect(this.worklet).connect(this.mute).connect(this.context.destination);
    await this.context.resume();
  }

  stop(): void {
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.mute?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.context?.close();
    this.context = undefined;
    this.stream = undefined;
    this.source = undefined;
    this.worklet = undefined;
    this.mute = undefined;
  }
}

export function speakWithBrowser(text: string, role: "caller" | "agent", onDone?: () => void): void {
  if (!("speechSynthesis" in window)) {
    onDone?.();
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = role === "agent" ? 1.02 : 1.08;
  utterance.pitch = role === "agent" ? 1.03 : 0.92;
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find((voice) => voice.lang.startsWith("en") && /Samantha|Google US|Aria/i.test(voice.name));
  if (preferred) utterance.voice = preferred;
  utterance.onend = () => onDone?.();
  utterance.onerror = () => onDone?.();
  window.speechSynthesis.speak(utterance);
}

export async function playBase64Audio(
  base64: string,
  mimeType = "audio/mpeg",
  onDone?: () => void,
): Promise<void> {
  const audio = new Audio(`data:${mimeType};base64,${base64}`);
  audio.onended = () => onDone?.();
  audio.onerror = () => onDone?.();
  try {
    await audio.play();
  } catch {
    onDone?.();
  }
}
