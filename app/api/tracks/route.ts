import { NextResponse } from "next/server";
import type { YouTubeVideo } from "../../../lib/types";

export const dynamic = "force-dynamic";

type SearchItem = {
  id?: { videoId?: string };
  snippet?: { title?: string; channelTitle?: string; publishedAt?: string; thumbnails?: { high?: { url?: string }; medium?: { url?: string }; default?: { url?: string } } };
};

type VideoDetails = { id?: string; contentDetails?: { duration?: string } };

function parseDuration(value: string | undefined) {
  if (!value) return 0;
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

export async function GET(request: Request) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "YOUTUBE_API_KEY is not configured." }, { status: 500 });

  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() || "official music video";
  const searchParams = new URLSearchParams({
    part: "snippet",
    type: "video",
    videoCategoryId: "10",
    videoEmbeddable: "true",
    videoSyndicated: "true",
    maxResults: "36",
    order: url.searchParams.get("q") ? "relevance" : "viewCount",
    q: query,
    key: apiKey,
  });

  try {
    const searchResponse = await fetch(`https://www.googleapis.com/youtube/v3/search?${searchParams.toString()}`, { next: { revalidate: 300 } });
    const searchPayload = await searchResponse.json() as { error?: { message?: string }; items?: SearchItem[] };
    if (!searchResponse.ok) return NextResponse.json({ error: searchPayload.error?.message || `YouTube search returned ${searchResponse.status}.` }, { status: 502 });

    const items = (searchPayload.items || []).filter((item) => item.id?.videoId && item.snippet?.title);
    const ids = items.map((item) => item.id!.videoId!);
    const details = new Map<string, number>();
    if (ids.length) {
      const detailsParams = new URLSearchParams({ part: "contentDetails", id: ids.join(","), key: apiKey });
      const detailsResponse = await fetch(`https://www.googleapis.com/youtube/v3/videos?${detailsParams.toString()}`, { next: { revalidate: 300 } });
      const detailsPayload = await detailsResponse.json() as { items?: VideoDetails[] };
      detailsPayload.items?.forEach((item) => { if (item.id) details.set(item.id, parseDuration(item.contentDetails?.duration)); });
    }

    const tracks: YouTubeVideo[] = items.map((item) => {
      const id = item.id!.videoId!;
      const snippet = item.snippet!;
      const image = snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || "/cover-fallback.svg";
      return {
        id,
        name: snippet.title || "Untitled video",
        duration: details.get(id) || 0,
        artist_name: snippet.channelTitle || "YouTube creator",
        album_name: "YouTube",
        album_image: image,
        image,
        shareurl: `https://www.youtube.com/watch?v=${id}`,
        source: "youtube",
      };
    });

    return NextResponse.json({ tracks });
  } catch {
    return NextResponse.json({ error: "YouTube could not be reached." }, { status: 502 });
  }
}
