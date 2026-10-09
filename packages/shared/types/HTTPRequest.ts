import { z } from "zod";
import { AudioSourceSchema } from "./basic";
import { ClientDataSchema } from "./WSBroadcast";

// Legacy upload schema (deprecated)
export const UploadAudioSchema = z.object({
  name: z.string(),
  audioData: z.string(), // base64 encoded audio data
  roomId: z.string(),
});
export type UploadAudioType = z.infer<typeof UploadAudioSchema>;

// R2 Upload URL Request
export const GetUploadUrlSchema = z.object({
  roomId: z.string(),
  fileName: z.string(),
  contentType: z
    .string()
    .refine(
      (type) => type.startsWith("audio/") || type === "video/webm",
      "Content type must be an audio mime type or video/webm"
    ),
});
export type GetUploadUrlType = z.infer<typeof GetUploadUrlSchema>;

// R2 Upload URL Response - simplified to only essential fields
export const UploadUrlResponseSchema = z.object({
  uploadUrl: z.string().url(),
  publicUrl: z.string().url(),
});
export type UploadUrlResponseType = z.infer<typeof UploadUrlResponseSchema>;

// Upload Complete Request - simplified to only essential fields
export const UploadCompleteSchema = z.object({
  roomId: z.string(),
  originalName: z.string(),
  publicUrl: z.string().url(),
  // Song details read from the file's embedded tags (when present)
  metadata: AudioSourceSchema.pick({ title: true, artist: true, album: true, duration: true, isrc: true }).optional(),
});
export type UploadCompleteType = z.infer<typeof UploadCompleteSchema>;

// Upload Complete Response
export const UploadCompleteResponseSchema = z.object({
  success: z.boolean(),
});
export type UploadCompleteResponseType = z.infer<
  typeof UploadCompleteResponseSchema
>;

// Audio fetch request (unchanged)
export const GetAudioSchema = z.object({
  id: z.string(),
});
export type GetAudioType = z.infer<typeof GetAudioSchema>;

// Default audio fetch response
export const GetDefaultAudioSchema = z.array(AudioSourceSchema);
export type GetDefaultAudioType = z.infer<typeof GetDefaultAudioSchema>;

export const RoomSchema = z.object({
  roomId: z.string(),
  clientCount: z.number(),
  audioSourceCount: z.number(),
  hasSpatialAudio: z.boolean(),
});
export type RoomType = z.infer<typeof RoomSchema>;

export const GetActiveRoomsSchema = z.number();
export type GetActiveRoomsType = z.infer<typeof GetActiveRoomsSchema>;

export const DiscoveryRoomSchema = z.object({
  roomId: z.string(),
  clients: z.array(ClientDataSchema),
  audioSources: z.array(AudioSourceSchema),
  playbackState: z.object({
    type: z.enum(["playing", "paused"]),
    audioSource: z.string(), // URL of the audio source
  }),
});
export type DiscoveryRoomType = z.infer<typeof DiscoveryRoomSchema>;

export const DiscoverRoomsSchema = z.array(DiscoveryRoomSchema);
export type DiscoverRoomsType = z.infer<typeof DiscoverRoomsSchema>;

// Lyrics lookup (GET /lyrics). `track` is the display name derived from the audio URL.
export const GetLyricsQuerySchema = z.object({
  track: z.string().trim().min(1),
  // Known song details (from tags or a music provider) take precedence over parsing `track`
  artist: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  duration: z.coerce.number().positive().max(3600).optional(), // seconds
});
export type GetLyricsQueryType = z.infer<typeof GetLyricsQuerySchema>;

const LyricsMatchSchema = z.object({
  trackName: z.string(),
  artistName: z.string(),
});

export const LyricsResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("synced"),
    syncedLyrics: z.string(), // LRC format
    plainLyrics: z.string().optional(),
    match: LyricsMatchSchema,
  }),
  z.object({
    status: z.literal("plain"),
    plainLyrics: z.string(),
    match: LyricsMatchSchema,
  }),
  z.object({
    status: z.literal("instrumental"),
    match: LyricsMatchSchema,
  }),
  z.object({
    status: z.literal("not_found"),
  }),
]);
export type LyricsResponseType = z.infer<typeof LyricsResponseSchema>;
