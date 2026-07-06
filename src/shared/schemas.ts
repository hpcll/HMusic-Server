import { z } from "zod";

export const playModeSchema = z.enum([
  "list_loop",
  "single_loop",
  "shuffle",
  "sequence",
  "single_once",
]);

export const clientTrackSchema = z.record(z.unknown());

export const trackSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    sourceTrackId: z.string().min(1),
    title: z.string().min(1),
    artist: z.string().min(1),
    album: z.string().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    coverUrl: z.string().url().optional(),
    url: z.string().url().optional(),
    qualities: z.array(z.string()).optional(),
    raw: z.unknown().optional(),
  })
  .strict();
