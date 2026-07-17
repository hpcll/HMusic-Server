import type { HMusicTrack } from "./contracts.js";
import { resolvePublicBaseUrl } from "./public-base-url.js";

const sampleRate = 44100;
const durationSeconds = 3;
const frequencyHz = 440;
const channels = 1;
const bitsPerSample = 16;
const bytesPerSample = bitsPerSample / 8;
const dataSize = sampleRate * durationSeconds * channels * bytesPerSample;
const wavSize = 44 + dataSize;

export const testTonePath = "/api/v1/system/test-tone.wav";

export function createTestToneUrl(): string {
  return `${resolvePublicBaseUrl()}${testTonePath}`;
}

export function createTestToneTrack(): HMusicTrack {
  const url = createTestToneUrl();
  return {
    id: "manual:hmusic-test-tone",
    source: "manual",
    sourceTrackId: "hmusic-test-tone",
    title: "HMusic Test Tone",
    artist: "HMusic",
    album: "测试音频",
    durationMs: durationSeconds * 1000,
    url,
    qualities: ["source"],
    raw: {
      builtIn: true,
      url,
    },
  };
}

export function createTestToneWav(): Buffer {
  const buffer = Buffer.alloc(wavSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(wavSize - 8, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < sampleRate * durationSeconds; index += 1) {
    const fadeSamples = Math.floor(sampleRate * 0.03);
    const fadeIn = Math.min(1, index / fadeSamples);
    const fadeOut = Math.min(
      1,
      (sampleRate * durationSeconds - index) / fadeSamples,
    );
    const envelope = Math.min(fadeIn, fadeOut);
    const sample =
      Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate) *
      0.25 *
      envelope;
    buffer.writeInt16LE(
      Math.round(sample * 32767),
      44 + index * bytesPerSample,
    );
  }

  return buffer;
}
