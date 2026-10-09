import { IS_DEMO_MODE } from "@/demo";
import { globalManager } from "@/managers";
import { getMusicProvider } from "@/providers";
import { sendBroadcast } from "@/utils/responses";
import type { HandlerFunction } from "@/websocket/types";
import type { ExtractWSRequestFrom } from "@beatsync/shared";

export const handleStreamMusic: HandlerFunction<ExtractWSRequestFrom["STREAM_MUSIC"]> = async ({
  ws,
  message,
  server,
}) => {
  if (IS_DEMO_MODE) return;
  const roomId = ws.data.roomId;

  const provider = getMusicProvider();
  if (!provider) {
    console.error("Stream request ignored: no music provider is configured");
    return;
  }

  // Require room to exist before processing stream request
  const room = globalManager.getRoom(roomId);
  if (!room) {
    console.error(`Stream request failed: Room ${roomId} not found`);
    return;
  }

  // Check if this track is already being added
  const { trackId } = message;
  if (room.hasActiveStreamJob(trackId)) {
    console.log(`Track ${trackId} is already being streamed for room ${roomId}, ignoring duplicate request`);
    return;
  }

  // Add job to room and broadcast updated count
  room.addStreamJob(trackId);
  sendBroadcast({
    server,
    roomId,
    message: { type: "STREAM_JOB_UPDATE", activeJobCount: room.getActiveStreamJobCount() },
  });

  try {
    const source = await provider.getAudioSource({ trackId, roomId, trackName: message.trackName });
    const sources = room.addAudioSource(source);
    console.log(`Added ${provider.name} track ${trackId} to room ${roomId}: ${source.url}`);

    sendBroadcast({
      server,
      roomId,
      message: { type: "ROOM_EVENT", event: { type: "SET_AUDIO_SOURCES", sources } },
    });
  } catch (error) {
    console.error("Error in handleStreamMusic:", error);
  } finally {
    // Job completed or failed - remove from tracking and notify clients
    room.removeStreamJob(trackId);
    sendBroadcast({
      server,
      roomId,
      message: { type: "STREAM_JOB_UPDATE", activeJobCount: room.getActiveStreamJobCount() },
    });
  }
};
