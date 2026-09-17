import { NextResponse } from "next/server";
import type { LyricsPayload } from "../../../lib/types";

export const dynamic = "force-dynamic";

const LRCLIB = "https://lrclib.net/api";

type LrclibResult = {
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
  instrumental?: boolean;
  duration?: number;
  trackName?: string;
  artistName?: string;
};

type LrclibSearchResult = LrclibResult & {
  trackName?: string;
  artistName?: string;
  duration?: number;
};

function clean(value: string | null) {
  return value?.trim() || "";
}

function titleCandidates(rawTitle: string, artist: string) {
  const base = rawTitle
    .replace(/&quot;|&#34;|&ldquo;|&rdquo;/gi, "")
    .replace(/&amp;/gi, "&")
    .replace(/\s*[\[(].*?[\])]/g, "")
    .replace(/^\s*(?:official|lyrics|audio|video|song)\s*[-|:]\s*/i, "")
    .replace(/\s*(?:\||-)\s*(official|music video|audio|lyrics|visualizer|vevo|remaster|remastered|4k|hd).*$/i, "")
    .replace(/^[\s"'â€œâ€]+|[\s"'â€œâ€]+$/g, "")
    .trim();
  const parts = base.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  const artistLower = artist.toLowerCase();
  const candidates = [base];
  if (parts.length > 1) {
    candidates.push(parts.slice(1).join(" - "));
    candidates.push(parts.slice(0, -1).join(" - "));
  }
  if (artistLower) {
    candidates.push(base.replace(new RegExp(`^${escapeRegExp(artist)}\\s*[-|:]\\s*`, "i"), ""));
    candidates.push(base.replace(new RegExp(`\\s*[-|:]\\s*${escapeRegExp(artist)}$`, "i"), ""));
  }
  const words = base.split(/\s+/).filter(Boolean);
  for (let count = 2; count <= Math.min(6, words.length); count += 1) candidates.push(words.slice(0, count).join(" "));
  return [...new Set(candidates.map((candidate) => candidate.trim()).filter((candidate) => candidate.length > 1))].slice(0, 14);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function usable(result: LrclibResult | undefined) {
  return Boolean(result && (result.syncedLyrics || result.plainLyrics || result.instrumental));
}

function hasSynced(result: LrclibResult | undefined) {
  return Boolean(result?.syncedLyrics?.trim());
}

function normalizedTokens(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function lyricIdentity(rawTitle: string, artist: string) {
  const cleaned = rawTitle
    .replace(/\s*[\[(].*?[\])]/g, "")
    .replace(/\s*(?:\||-)\s*(official|music video|audio|lyrics|visualizer|vevo|remaster|remastered|4k|hd).*$/i, "")
    .trim();
  const parts = cleaned.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  const artistHint = parts.length > 1 ? parts[0] : artist;
  const titlePart = parts.length > 1 ? parts.slice(1).join(" - ") : cleaned;
  const titleCore = titlePart.split(/\b(?:feat\.?|ft\.?|featuring)\b/i)[0].trim();
  return { titleTokens: normalizedTokens(titleCore), artistTokens: normalizedTokens(artistHint).filter((token) => token.length > 2) };
}

function matchesIdentity(result: LrclibResult, rawTitle: string, artist: string, duration: number) {
  const { titleTokens, artistTokens } = lyricIdentity(rawTitle, artist);
  const candidateTitle = normalizedTokens(result.trackName || "");
  const candidateMetadata = normalizedTokens((result.trackName || "") + " " + (result.artistName || ""));
  if (!titleTokens.length || !titleTokens.every((token) => candidateTitle.includes(token))) return false;
  if (artistTokens.length && !artistTokens.every((token) => candidateMetadata.includes(token))) return false;
  if (duration > 0 && typeof result.duration === "number" && Math.abs(result.duration - duration) > Math.max(45, duration * 0.25)) return false;
  return true;
}

function payload(result: LrclibResult): LyricsPayload {
  return { syncedLyrics: result.syncedLyrics || undefined, plainLyrics: result.plainLyrics || undefined, instrumental: result.instrumental, sourceDuration: result.duration, source: "lrclib" };
}

async function readJson(url: string) {
  const response = await fetch(url, { next: { revalidate: 3600 }, headers: { Accept: "application/json" } });
  if (!response.ok) return undefined;
  return await response.json() as LrclibResult | LrclibSearchResult[];
}

function decodeCaptionText(value: string) {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replaceAll(String.fromCharCode(0x266A), "")
    .replaceAll(String.fromCharCode(0x266B), "")
    .replace(/\s+/g, " ")
    .trim();
}

async function readYouTubeTimedLyrics(videoId: string) {
  try {
    const pageResponse = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9" },
      next: { revalidate: 900 },
    });
    if (!pageResponse.ok) return undefined;
    const html = await pageResponse.text();
    const apiKey = html.match(/INNERTUBE_API_KEY":"([^"]+)/)?.[1];
    if (!apiKey) return undefined;
    const cookie = pageResponse.headers.get("set-cookie") || "";
    const playerResponse = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14)",
        Cookie: cookie,
      },
      body: JSON.stringify({ videoId, context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } } }),
      next: { revalidate: 900 },
    });
    if (!playerResponse.ok) return undefined;
    const player = await playerResponse.json() as {
      captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Array<{ baseUrl?: string; languageCode?: string; kind?: string }> } };
    };
    const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const track = tracks.find((item) => item.languageCode === "en" && item.kind !== "asr")
      || tracks.find((item) => item.languageCode === "en")
      || tracks.find((item) => item.kind !== "asr")
      || tracks[0];
    if (!track?.baseUrl) return undefined;
    const captionResponse = await fetch(track.baseUrl, {
      headers: { "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14)", Cookie: cookie },
      next: { revalidate: 900 },
    });
    if (!captionResponse.ok) return undefined;
    const xml = await captionResponse.text();
    const lines = [...xml.matchAll(/<p\s+([^>]+)>([\s\S]*?)<\/p>/gi)].map((match) => {
      const start = Number(match[1].match(/\bt="(\d+)"/)?.[1] || 0) / 1000;
      const duration = Number(match[1].match(/\bd="(\d+)"/)?.[1] || 0) / 1000;
      return { time: start, duration, text: decodeCaptionText(match[2]) };
    }).filter((line) => line.text);
    return lines.length ? lines : undefined;
  } catch {
    return undefined;
  }
}

function isBetter(candidate: LrclibResult, current: LrclibResult | undefined, duration: number) {
  if (!current) return true;
  if (!duration) return false;
  const candidateDistance = typeof candidate.duration === "number" ? Math.abs(candidate.duration - duration) : Number.POSITIVE_INFINITY;
  const currentDistance = typeof current.duration === "number" ? Math.abs(current.duration - duration) : Number.POSITIVE_INFINITY;
  return candidateDistance < currentDistance;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const artist = clean(url.searchParams.get("artist"));
  const rawTitle = clean(url.searchParams.get("title"));
  const videoId = clean(url.searchParams.get("videoId"));
  const duration = Number(url.searchParams.get("duration") || 0);
  if (!artist || !rawTitle) return NextResponse.json({ error: "Artist and title are required." }, { status: 400 });

  try {
    if (videoId) {
      const timedLyrics = await readYouTubeTimedLyrics(videoId);
      if (timedLyrics) return NextResponse.json({ timedLyrics, source: "youtube" });
    }
    const candidates = titleCandidates(rawTitle, artist);
    let bestSynced: LrclibResult | undefined;
    let plainFallback: LrclibResult | undefined;
    for (const title of candidates) {
      const exactParams = new URLSearchParams({ artist_name: artist, track_name: title });
      if (duration > 0) exactParams.set("duration", String(Math.round(duration)));
      const exact = await readJson(`${LRCLIB}/get?${exactParams.toString()}`);
      if (exact && !Array.isArray(exact) && usable(exact) && matchesIdentity(exact, rawTitle, artist, duration)) {
        if (hasSynced(exact) && isBetter(exact, bestSynced, duration)) bestSynced = exact;
        else if (!hasSynced(exact) && isBetter(exact, plainFallback, duration)) plainFallback = exact;
      }
    }

    for (const title of candidates) {
      const queries = [
        new URLSearchParams({ artist_name: artist, track_name: title }),
        new URLSearchParams({ track_name: title }),
      ];
      for (const query of queries) {
        const search = await readJson(`${LRCLIB}/search?${query.toString()}`);
        if (!Array.isArray(search)) continue;
        for (const result of search) {
          if (!matchesIdentity(result, rawTitle, artist, duration)) continue;
          if (hasSynced(result) && isBetter(result, bestSynced, duration)) bestSynced = result;
          else if (usable(result) && isBetter(result, plainFallback, duration)) plainFallback = result;
        }
      }
    }

    if (bestSynced) return NextResponse.json(payload(bestSynced));
    if (plainFallback) return NextResponse.json(payload(plainFallback));
    return NextResponse.json({ error: "No lyrics found for this track." }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "Lyrics service could not be reached." }, { status: 502 });
  }
}
