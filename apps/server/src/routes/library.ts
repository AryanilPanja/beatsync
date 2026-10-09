import { getLibraryProvider } from "@/providers";
import { corsHeaders, errorResponse } from "@/utils/responses";

export const LIBRARY_ROUTE_PREFIX = "/library/";

/** GET /library/audio/<id> and /library/artwork/<id> for the "My Library" provider */
export async function handleLibraryRequest(req: Request, pathname: string): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return errorResponse("Method not allowed", 405);

  const library = getLibraryProvider();
  if (!library) return errorResponse("Not found", 404);

  const [kind, id] = pathname.slice(LIBRARY_ROUTE_PREFIX.length).split("/");
  if (!id) return errorResponse("Not found", 404);

  if (kind === "audio") {
    const path = library.getTrackPath(id);
    if (!path) return errorResponse("Not found", 404);

    const file = Bun.file(path);
    return new Response(file, {
      headers: {
        ...corsHeaders,
        "Content-Type": file.type || "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  if (kind === "artwork") {
    const artwork = await library.getArtwork(id);
    if (!artwork) return errorResponse("Not found", 404);

    return new Response(new Blob([new Uint8Array(artwork.data)]), {
      headers: { ...corsHeaders, "Content-Type": artwork.mimeType, "Cache-Control": "private, max-age=86400" },
    });
  }

  return errorResponse("Not found", 404);
}
