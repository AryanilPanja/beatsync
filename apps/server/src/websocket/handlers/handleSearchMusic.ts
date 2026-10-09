import { IS_DEMO_MODE } from "@/demo";
import { getMusicProvider } from "@/providers";
import { sendUnicast } from "@/utils/responses";
import type { HandlerFunction } from "@/websocket/types";
import type { ExtractWSRequestFrom } from "@beatsync/shared";

export const handleSearchMusic: HandlerFunction<ExtractWSRequestFrom["SEARCH_MUSIC"]> = async ({ ws, message }) => {
  if (IS_DEMO_MODE) return;

  const provider = getMusicProvider();
  if (!provider) {
    sendUnicast({
      ws,
      message: { type: "SEARCH_RESPONSE", response: { type: "error", message: "No music provider is configured" } },
    });
    return;
  }

  try {
    const result = await provider.search(message.query, message.offset ?? 0);
    sendUnicast({ ws, message: { type: "SEARCH_RESPONSE", response: { type: "success", response: result } } });
  } catch (error) {
    console.error(`Search failed (provider: ${provider.name}):`, error);
    sendUnicast({
      ws,
      message: { type: "SEARCH_RESPONSE", response: { type: "error", message: "An error occurred while searching" } },
    });
  }
};
