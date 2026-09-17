export type YouTubeVideo = {
  id: string;
  name: string;
  duration: number;
  artist_name: string;
  album_name: string;
  album_image: string;
  image?: string;
  shareurl: string;
  source: "youtube";
  audioUrl?: string;
  audioMimeType?: string;
};

export type LyricLine = {
  time: number;
  text: string;
  duration?: number;
};

export type LyricsPayload = {
  syncedLyrics?: string;
  timedLyrics?: LyricLine[];
  plainLyrics?: string;
  instrumental?: boolean;
  sourceDuration?: number;
  source?: "lrclib" | "youtube";
  error?: string;
};
