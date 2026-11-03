/* Shrinks a before/after clip in the browser before upload (owner, 11/03/2026:
   a 90 MB phone video hit the 50 MB storage limit). Re-encodes to an H.264 MP4
   with its index at the front, so it starts fast on a tap and plays on every
   phone (iPhone HEVC .mov files don't). Loaded only when a video is picked —
   the library never reaches the funnel pages. */
const SHORT_SIDE = 720;
const MAX_VIDEO_BPS = 2_500_000;
const MIN_VIDEO_BPS = 400_000;
const AUDIO_BPS = 96_000;
const TARGET_BYTES = 40 * 1024 * 1024; // room under the 50 MB limit for encoder overshoot

export async function shrinkVideo(file: File, onPct: (n: number) => void): Promise<File> {
  const { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output } = await import("mediabunny");
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("no video track in this file");
    const seconds = await input.computeDuration();
    const fit = (TARGET_BYTES * 8) / Math.max(seconds, 1) - AUDIO_BPS;
    if (fit < MIN_VIDEO_BPS) throw new Error(`video is ${Math.round(seconds / 60)} minutes long — too long to fit, trim it first`);
    const scale = Math.min(1, SHORT_SIDE / Math.min(track.displayWidth, track.displayHeight));
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input,
      output,
      video: { width: Math.round((track.displayWidth * scale) / 2) * 2, codec: "avc", bitrate: Math.round(Math.min(MAX_VIDEO_BPS, fit)), forceTranscode: true },
      audio: { codec: "aac", bitrate: AUDIO_BPS },
    });
    if (!conversion.isValid) throw new Error("this browser can't convert this video");
    conversion.onProgress = (p) => onPct(Math.round(p * 100));
    await conversion.execute();
    const buffer = output.target.buffer;
    if (!buffer) throw new Error("conversion produced no file");
    return new File([buffer], file.name.replace(/\.[^.]+$/, "") + ".mp4", { type: "video/mp4" });
  } finally {
    input.dispose?.();
  }
}
