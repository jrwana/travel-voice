class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 24000;
    this.pending = [];
    this.samplesPerChunk = 2400;
    this.sourcePosition = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;
    const ratio = sampleRate / this.targetRate;
    for (let position = this.sourcePosition; position < input.length; position += ratio) {
      const sample = Math.max(-1, Math.min(1, input[Math.floor(position)]));
      this.pending.push(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
      this.sourcePosition = position + ratio - input.length;
    }
    if (this.sourcePosition < 0) this.sourcePosition = 0;

    while (this.pending.length >= this.samplesPerChunk) {
      const pcm = new Int16Array(this.pending.splice(0, this.samplesPerChunk));
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
