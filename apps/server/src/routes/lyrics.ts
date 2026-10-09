import { LYRICS_MANAGER } from "@/managers/LyricsManager";
import { errorResponse, jsonResponse } from "@/utils/responses";
import type { LyricsResponseType } from "@beatsync/shared";
import { GetLyricsQuerySchema } from "@beatsync/shared";

export async function handleGetLyrics(req: Request) {
  if (req.method !== "GET") {
    return errorResponse("Method not allowed", 405);
  }

  const { searchParams } = new URL(req.url);
  const parseResult = GetLyricsQuerySchema.safeParse({
    track: searchParams.get("track") ?? "",
    duration: searchParams.get("duration") ?? undefined,
    artist: searchParams.get("artist") ?? undefined,
    title: searchParams.get("title") ?? undefined,
  });

  if (!parseResult.success) {
    return errorResponse(`Invalid request data: ${parseResult.error.message}`, 400);
  }

  try {
    const response: LyricsResponseType = await LYRICS_MANAGER.getLyrics(parseResult.data);
    return jsonResponse(response);
  } catch (error) {
    // Upstream failure: not cached, so the client may retry later
    console.error("Failed to fetch lyrics:", error);
    const response: LyricsResponseType = { status: "not_found" };
    return jsonResponse(response, 502);
  }
}
