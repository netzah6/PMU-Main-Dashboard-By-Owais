// Browser-side half of the 🎤 voice note (owner, 2026-10-07: "I want to
// create a voice recording like it's a text message"). The browser records
// in whatever it supports (WebM/Opus in Chrome, MP4/AAC in Safari) — neither
// is safe over MMS — so the recording is re-encoded here to a small MP3,
// which iPhones and Androids both play straight from the text.
//
// Size is the whole game: carriers cap MMS around 1 MB (AT&T and Verizon
// 1.0 MB), and GoHighLevel recommends under 500 KB. Mono speech at
// 22.05 kHz / 32 kbps is ~4 KB a second, so the 2-minute cap lands near
// 480 KB.

export const VOICE_NOTE_MAX_SECONDS = 120;
const RATE = 22_050;
const KBPS = 32;

/** Can this browser record at all? (Old Safari, some in-app browsers can't.) */
export function canRecord(): boolean {
  return typeof window !== "undefined"
    && !!navigator.mediaDevices?.getUserMedia
    && typeof window.MediaRecorder !== "undefined";
}

/** Re-encode a browser recording as mono MP3, small enough for a text. */
export async function toMp3(recording: Blob): Promise<{ mp3: Blob; seconds: number }> {
  const AC = window.AudioContext
    ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  try {
    const decoded = await ctx.decodeAudioData(await recording.arrayBuffer());
    // Resample + mix down to one channel in one pass.
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * RATE)), RATE);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const mono = (await off.startRendering()).getChannelData(0);

    const pcm = new Int16Array(mono.length);
    for (let i = 0; i < mono.length; i++) {
      const s = Math.max(-1, Math.min(1, mono[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    // Loaded only when someone records, so the AI tab doesn't carry it.
    const { Mp3Encoder } = await import("@breezystack/lamejs");
    const enc = new Mp3Encoder(1, RATE, KBPS);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < pcm.length; i += 1152) {
      const chunk = enc.encodeBuffer(pcm.subarray(i, i + 1152));
      if (chunk.length) parts.push(new Uint8Array(chunk));
    }
    const tail = enc.flush();
    if (tail.length) parts.push(new Uint8Array(tail));
    return { mp3: new Blob(parts as BlobPart[], { type: "audio/mpeg" }), seconds: decoded.duration };
  } finally {
    void ctx.close();
  }
}
