// AudioWorklet processor that downsamples the mic stream to 16 kHz
// mono linear16 PCM and posts Int16 frames to the main thread. The
// streaming transcription bridge ships those frames straight to
// Deepgram (encoding=linear16, sample_rate=16000).
//
// Loaded by `useStreamingTranscript` via
// `audioContext.audioWorklet.addModule('/pcm-worklet.js')`. The file
// lives under `public/` so Vite serves it verbatim — AudioWorklets
// must be standalone JS, not imported through the module graph.
//
// AudioWorkletGlobalScope provides `sampleRate` (the audio context's
// rate) so we don't need to be told it from the main thread.

/* eslint-env worker */
class PcmDownsamplerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Downsample target. 16 kHz is the Deepgram-recommended rate for
    // their nova-3-medical model and keeps WS bandwidth low (~32 KB/s
    // per channel after Int16 encoding).
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate;
    // Fractional source-sample cursor — keeps the resampler smooth
    // across process() boundaries when ratio isn't an integer
    // (typical: 48000 / 16000 = 3, but 44100 / 16000 ≈ 2.756).
    this.cursor = 0;
    // Output frame size. ~50 ms at 16 kHz keeps the WS frames small
    // and the perceived transcript lag low.
    this.frameSize = 800;
    this.outBuf = new Int16Array(this.frameSize);
    this.outIdx = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    // Channel 0 only — the worklet sits behind a MediaStreamSource
    // that's already mono, but be defensive.
    const ch = input[0];
    if (!ch) return true;

    let i = this.cursor;
    while (i < ch.length) {
      // Linear nearest-sample. A proper sinc resampler would sound
      // better for music; for speech recognition the difference
      // beneath Deepgram's denoiser is inaudible.
      const idx = Math.floor(i);
      // Clamp to [-1, 1] then quantize to Int16.
      const sample = Math.max(-1, Math.min(1, ch[idx] ?? 0));
      this.outBuf[this.outIdx++] = Math.round(sample * 32767);
      if (this.outIdx >= this.frameSize) {
        // Post a fresh copy of the buffer. Transferring would be
        // cheaper but means we'd have to allocate on every frame;
        // 800-sample copies are cheap relative to the WS round-trip.
        this.port.postMessage(this.outBuf.buffer.slice(0));
        this.outIdx = 0;
      }
      i += this.ratio;
    }
    // Carry the leftover fractional cursor into the next process()
    // call so we don't lose phase between buffers.
    this.cursor = i - ch.length;
    return true;
  }
}

registerProcessor("pcm-downsampler", PcmDownsamplerProcessor);
