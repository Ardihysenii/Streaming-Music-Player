"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { deleteOfflineTrack, getOfflineTrack, listOfflineTracks, saveOfflineTrack, type OfflineTrack } from "../lib/offline-store";
import type { LyricsPayload, LyricLine, YouTubeVideo } from "../lib/types";

type View = "home" | "browse" | "library";
type LyricsState = "idle" | "loading" | "ready" | "plain" | "missing" | "error";
type YouTubePlayerEvent = { data: number };
type YouTubePlayerInstance = {
  playVideo: () => void;
  pauseVideo: () => void;
  stopVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  setVolume: (volume: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  destroy: () => void;
};
type YouTubePlayerApi = {
  Player: new (element: string | HTMLElement, options: { events?: { onReady?: () => void; onStateChange?: (event: YouTubePlayerEvent) => void } }) => YouTubePlayerInstance;
};

declare global {
  interface Window {
    YT?: YouTubePlayerApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

function formatTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function parseLrc(value: string): LyricLine[] {
  const offsetMatch = value.match(/\[offset:([+-]?\d+)\]/i);
  const offsetSeconds = offsetMatch ? Number(offsetMatch[1]) / 1000 : 0;
  return value.split(/\r?\n/).flatMap((line) => {
    const timestamps = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    const text = line.replace(/\[\d{1,3}:\d{2}(?:\.\d{1,3})?\]/g, "").trim();
    if (!text || !timestamps.length) return [];
    return timestamps.map((match) => {
      const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
      const sourceTime = Number(match[1]) * 60 + Number(match[2]) + fraction + offsetSeconds;
      return { time: Math.max(0, sourceTime), text };
    });
  }).sort((a, b) => a.time - b.time);
}

function calculateLyricScale(playerDuration: number, sourceDuration: number) {
  if (playerDuration < 30 || sourceDuration < 30) return 1;
  return Math.min(1.06, Math.max(0.94, playerDuration / sourceDuration));
}

function lyricTitle(track: YouTubeVideo) {
  let title = track.name.replace(/\s*[\[(].*?[\])]/g, "").trim();
  const artist = track.artist_name.trim().toLowerCase();
  const parts = title.split(/\s+-\s+/);
  if (parts.length > 1 && artist) {
    const first = parts[0].toLowerCase();
    const last = parts[parts.length - 1].toLowerCase();
    if (first.includes(artist) || artist.includes(first)) title = parts.slice(1).join(" - ");
    else if (last.includes(artist) || artist.includes(last)) title = parts.slice(0, -1).join(" - ");
  }
  return title.replace(/\s*-\s*(official.*|music video.*)$/i, "").trim();
}

function Glyph({ children }: { children: string }) {
  return <span className="glyph" aria-hidden="true">{children}</span>;
}

export default function HomePage() {
  const [tracks, setTracks] = useState<YouTubeVideo[]>([]);
  const [savedTracks, setSavedTracks] = useState<YouTubeVideo[]>([]);
  const [offlineTracks, setOfflineTracks] = useState<OfflineTrack[]>([]);
  const [selected, setSelected] = useState<YouTubeVideo | null>(null);
  const [offlineUrl, setOfflineUrl] = useState("");
  const [offlineBusy, setOfflineBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [view, setView] = useState<View>("home");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [focusMode, setFocusMode] = useState(false);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(80);
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [lyricsState, setLyricsState] = useState<LyricsState>("idle");
  const [lyricsSource, setLyricsSource] = useState<"lrclib" | "youtube" | "none">("none");
  const playerFrameRef = useRef<HTMLIFrameElement | null>(null);
  const playerApiRef = useRef<YouTubePlayerInstance | null>(null);
  const offlineAudioRef = useRef<HTMLAudioElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const importTrackRef = useRef<YouTubeVideo | null>(null);

  const loadTracks = async (search = "") => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/tracks${search ? `?q=${encodeURIComponent(search)}` : ""}`);
      const payload = (await response.json()) as { tracks?: YouTubeVideo[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not load music.");
      setTracks(payload.tracks ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load music.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTracks();
    try {
      const saved = JSON.parse(window.localStorage.getItem("sonora:favorites:tracks") || "[]");
      if (Array.isArray(saved)) setSavedTracks(saved.filter((track): track is YouTubeVideo => Boolean(track && typeof track.id === "string")));
    } catch { /* Ignore malformed local preferences. */ }
    void listOfflineTracks().then(setOfflineTracks).catch(() => setToast("Offline storage is unavailable in this browser"));
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    setOfflineUrl("");
    if (!selected) return undefined;
    void getOfflineTrack(selected.id).then((stored) => {
      if (cancelled || !stored) return;
      objectUrl = URL.createObjectURL(stored.audio);
      setOfflineUrl(objectUrl);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [selected, offlineTracks]);

  useEffect(() => {
    const isOfflineSelected = Boolean(selected && offlineTracks.some((track) => track.id === selected.id));
    if (!selected || isOfflineSelected || offlineUrl) {
      playerApiRef.current = null;
      return undefined;
    }
    let cancelled = false;
    let createdPlayer: YouTubePlayerInstance | null = null;
    const previousReady = window.onYouTubeIframeAPIReady;
    const initialize = () => {
      if (cancelled || !window.YT?.Player || !playerFrameRef.current) return;
      createdPlayer = new window.YT.Player("sonora-youtube-player", {
        events: {
          onReady: () => {
            if (cancelled || !createdPlayer) return;
            playerApiRef.current = createdPlayer;
            createdPlayer.setVolume(volume);
            setCurrentTime(createdPlayer.getCurrentTime());
          },
          onStateChange: (event) => {
            if (event.data === 1) setIsPlaying(true);
            if (event.data === 2) setIsPlaying(false);
            if (event.data === 0) { setIsPlaying(false); setCurrentTime(0); }
          },
        },
      });
    };
    window.onYouTubeIframeAPIReady = initialize;
    if (window.YT?.Player) initialize();
    else if (!document.querySelector("script[data-sonora-youtube-api]")) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.dataset.sonoraYoutubeApi = "true";
      document.head.appendChild(script);
    }
    const clock = window.setInterval(() => {
      if (!playerApiRef.current) return;
      setCurrentTime(playerApiRef.current.getCurrentTime());
    }, 100);
    return () => {
      cancelled = true;
      window.clearInterval(clock);
      if (createdPlayer) createdPlayer.destroy();
      playerApiRef.current = null;
      if (window.onYouTubeIframeAPIReady === initialize) window.onYouTubeIframeAPIReady = previousReady;
    };
  }, [selected, offlineUrl, offlineTracks]);

  useEffect(() => {
    if (!selected) {
      setLyrics([]);
      setLyricsState("idle");
      setLyricsSource("none");
      return undefined;
    }
    const controller = new AbortController();
    setLyrics([]);
    setLyricsState("loading");
    setLyricsSource("none");
    const params = new URLSearchParams({ artist: selected.artist_name, title: lyricTitle(selected), duration: String(selected.duration || 0), videoId: selected.id });
    fetch(`/api/lyrics?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as LyricsPayload;
        if (!response.ok) throw new Error(payload.error || "No lyrics found");
        if (payload.timedLyrics?.length) {
          setLyrics(payload.timedLyrics);
          setLyricsState("ready");
          setLyricsSource("youtube");
        } else if (payload.syncedLyrics) {
          const scale = calculateLyricScale(selected.duration, payload.sourceDuration || 0);
          setLyrics(parseLrc(payload.syncedLyrics).map((line) => ({ ...line, time: line.time * scale })));
          setLyricsState("ready");
          setLyricsSource("lrclib");
        } else if (payload.plainLyrics) {
          setLyrics(payload.plainLyrics.split(/\r?\n/).filter(Boolean).map((text) => ({ time: 0, text })));
          setLyricsState("plain");
          setLyricsSource("lrclib");
        } else {
          setLyricsState("missing");
        }
      })
      .catch((lyricsError) => {
        if (lyricsError instanceof DOMException && lyricsError.name === "AbortError") return;
        setLyricsState("missing");
        setLyricsSource("youtube");
      });
    return () => controller.abort();
  }, [selected]);

  const visibleTracks = useMemo(() => {
    if (view !== "library") return tracks;
    const byId = new Map<string, YouTubeVideo>();
    [...offlineTracks, ...savedTracks].forEach((track) => byId.set(track.id, track));
    return [...byId.values()];
  }, [offlineTracks, savedTracks, tracks, view]);
  const heroTrack = tracks[0];
  const activeLyricIndex = lyricsState === "ready" ? lyrics.reduce((active, line, index) => line.time <= currentTime ? index : active, -1) : -1;

  useEffect(() => {
    if (activeLyricIndex < 0) return;
    document.querySelector(".lyric-line.active")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeLyricIndex]);

  const sendPlayerCommand = (func: string, args: unknown[] = []) => {
    const audio = offlineAudioRef.current;
    if (offlineUrl && audio) {
      if (func === "playVideo") void audio.play();
      if (func === "pauseVideo") audio.pause();
      if (func === "stopVideo") { audio.pause(); audio.currentTime = 0; }
      if (func === "seekTo") audio.currentTime = Number(args[0]) || 0;
      if (func === "setVolume") audio.volume = Math.max(0, Math.min(1, (Number(args[0]) || 0) / 100));
      return;
    }
    const player = playerApiRef.current;
    if (player) {
      if (func === "playVideo") player.playVideo();
      if (func === "pauseVideo") player.pauseVideo();
      if (func === "stopVideo") player.stopVideo();
      if (func === "seekTo") player.seekTo(Number(args[0]) || 0, true);
      if (func === "setVolume") player.setVolume(Number(args[0]) || 0);
      return;
    }
    const iframe = document.getElementById("sonora-youtube-player") as HTMLIFrameElement | null;
    iframe?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "https://www.youtube.com");
  };

  const playTrack = (track: YouTubeVideo) => {
    setSelected(track);
    setCurrentTime(0);
    setIsPlaying(true);
    setToast("");
  };

  const closePlayer = () => {
    sendPlayerCommand("stopVideo");
    setSelected(null);
    setIsPlaying(false);
    setCurrentTime(0);
  };

  const togglePlayback = () => {
    if (!selected) return;
    sendPlayerCommand(isPlaying ? "pauseVideo" : "playVideo");
    setIsPlaying(!isPlaying);
  };

  const seekBy = (amount: number) => {
    if (!selected) return;
    const next = Math.max(0, Math.min(selected.duration || currentTime + amount, currentTime + amount));
    setCurrentTime(next);
    sendPlayerCommand("seekTo", [next, true]);
  };

  const seekTo = (value: number) => {
    setCurrentTime(value);
    sendPlayerCommand("seekTo", [value, true]);
  };

  const setPlayerVolume = (value: number) => {
    setVolume(value);
    sendPlayerCommand("setVolume", [value]);
  };

  const toggleFullScreen = async () => {
    const player = document.getElementById("sonora-player-screen");
    if (!player) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await player.requestFullscreen();
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = query.trim();
    setActiveQuery(next);
    setView("browse");
    void loadTracks(next);
  };

  const toggleFavorite = (track: YouTubeVideo) => {
    const exists = savedTracks.some((item) => item.id === track.id);
    const next = exists ? savedTracks.filter((item) => item.id !== track.id) : [...savedTracks, track];
    setSavedTracks(next);
    window.localStorage.setItem("sonora:favorites:tracks", JSON.stringify(next));
    setToast(exists ? "Removed from your library" : "Saved to your library");
  };

  const storeOfflineAudio = async (track: YouTubeVideo, audio: Blob) => {
    setOfflineBusy(true);
    try {
      await saveOfflineTrack({ ...track, audio, audioType: audio.type || "audio/mpeg", bytes: audio.size, savedAt: Date.now() });
      setOfflineTracks(await listOfflineTracks());
      setToast(`${track.name} is available offline`);
    } catch {
      setToast("Could not save this audio on the device");
    } finally {
      setOfflineBusy(false);
    }
  };

  const downloadTrack = async (track: YouTubeVideo) => {
    if (!track.audioUrl) {
      importTrackRef.current = track;
      importInputRef.current?.click();
      return;
    }
    setOfflineBusy(true);
    try {
      const response = await fetch(track.audioUrl);
      if (!response.ok) throw new Error("Audio download failed");
      await storeOfflineAudio(track, await response.blob());
    } catch {
      setOfflineBusy(false);
      setToast("This source did not provide a downloadable audio file");
    }
  };

  const removeOfflineTrack = async (track: YouTubeVideo) => {
    try {
      await deleteOfflineTrack(track.id);
      setOfflineTracks(await listOfflineTracks());
      setToast("Removed from offline storage");
    } catch {
      setToast("Could not remove the offline track");
    }
  };

  const handleOfflineFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const track = importTrackRef.current;
    event.target.value = "";
    importTrackRef.current = null;
    if (!file || !track) return;
    if (!file.type.startsWith("audio/")) {
      setToast("Choose an audio file");
      return;
    }
    await storeOfflineAudio(track, file);
  };

  const shufflePlay = () => {
    if (!visibleTracks.length) return;
    playTrack(visibleTracks[Math.floor(Math.random() * visibleTracks.length)]);
  };

  const renderTrack = (track: YouTubeVideo) => {
    const isFavorite = savedTracks.some((item) => item.id === track.id);
    const isOffline = offlineTracks.some((item) => item.id === track.id);
    const isSelected = selected?.id === track.id;
    return (
      <article className={`track-card ${isSelected ? "selected" : ""}`} key={track.id}>
        <button className="cover" type="button" onClick={() => playTrack(track)} aria-label={`Play ${track.name}`}>
          <img src={track.album_image || track.image || "/cover-fallback.svg"} alt="" />
          <span className="cover-play">{isSelected ? "Ⅱ" : "▶"}</span>
        </button>
        <div className="track-title" title={track.name}>{track.name}</div>
        <p className="track-artist">{track.artist_name} · {track.duration ? formatTime(track.duration) : "Track"}</p>
        <div className="card-actions">
          <button type="button" className={isFavorite ? "saved" : ""} onClick={() => toggleFavorite(track)}>{isFavorite ? "♥ Saved" : "♡ Save"}</button>
          <button type="button" className={isOffline ? "saved" : ""} disabled={offlineBusy} onClick={() => isOffline ? void removeOfflineTrack(track) : void downloadTrack(track)}>{isOffline ? "✓ Offline" : track.audioUrl ? "⇩ Download" : "⇧ Import"}</button>
          <button type="button" onClick={() => playTrack(track)}>{isSelected ? "Playing" : "Play"}</button>
        </div>
      </article>
    );
  };

  return (
    <div className={`app-shell ${focusMode ? "focus-mode" : ""}`}>
      <aside className="sidebar">
        <a className="brand" href="#top"><span className="brand-mark">◈</span>sonora</a>
        <div>
          <p className="nav-label">Your space</p>
          <nav className="nav" aria-label="Main navigation">
            <button className={view === "home" ? "active" : ""} type="button" onClick={() => setView("home")}><Glyph>⌂</Glyph><span>Home</span></button>
            <button className={view === "browse" ? "active" : ""} type="button" onClick={() => setView("browse")}><Glyph>⌕</Glyph><span>Search</span></button>
            <button className={view === "library" ? "active" : ""} type="button" onClick={() => setView("library")}><Glyph>▣</Glyph><span>Your library</span></button>
          </nav>
        </div>
        <div>
          <p className="nav-label">Your collection</p>
          <nav className="nav">
            <button type="button" onClick={() => setView("library")}><Glyph>♡</Glyph><span>Liked tracks ({savedTracks.length})</span></button>
            <button type="button" onClick={() => setToast("Playlists are ready for the next build")}><Glyph>＋</Glyph><span>Create playlist</span></button>
          </nav>
        </div>
        <div className="side-note"><strong>Sound, without noise.</strong><p>Sonora keeps the music front and center. YouTube captions appear when a selected track provides them.</p></div>
      </aside>

      <main className="main" id="top">
        <header className="topbar">
          <form className="search" onSubmit={submitSearch}>
            <span className="search-icon" aria-hidden="true">⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="What do you want to play?" aria-label="Search YouTube music" />
            <button type="submit" aria-label="Search">Search</button>
          </form>
          <div className="profile-pill"><span>Local profile</span><span className="avatar">A</span></div>
        </header>

        {view === "home" ? (
          <section className="welcome-panel">
            <div className="welcome-copy">
              <p className="eyebrow">Your personal listening space</p>
              <h1>Good evening, Ardi.</h1>
              <p>Open a track, turn on subtitles, and let Sonora stay out of the way.</p>
              <div className="welcome-actions"><button className="primary" type="button" onClick={shufflePlay}>▶ Shuffle play</button><button className="secondary" type="button" onClick={() => setView("browse")}>Browse music</button></div>
            </div>
            {heroTrack ? <div className="hero-art"><img src={heroTrack.album_image || "/cover-fallback.svg"} alt="" /><span>NOW DISCOVERING</span></div> : null}
          </section>
        ) : null}

        {view === "home" ? (
          <section className="tools-section">
            <div className="section-heading"><div><p className="eyebrow">Custom tools</p><h2>Make listening yours</h2></div></div>
            <div className="tool-grid">
              <button className={`tool-card ${focusMode ? "tool-active" : ""}`} type="button" onClick={() => { setFocusMode(!focusMode); setToast(!focusMode ? "Focus mode on" : "Focus mode off"); }}><span className="tool-icon">◌</span><span><strong>Focus mode</strong><small>{focusMode ? "Recommendations hidden" : "Clear the noise"}</small></span><span className="tool-arrow">↗</span></button>
              <button className={`tool-card ${captionsEnabled ? "tool-active" : ""}`} type="button" onClick={() => { setCaptionsEnabled(!captionsEnabled); setToast(!captionsEnabled ? "Subtitles enabled" : "Subtitles disabled"); }}><span className="tool-icon">CC</span><span><strong>Subtitle mode</strong><small>{captionsEnabled ? "Captions are on" : "Captions are off"}</small></span><span className="tool-arrow">↗</span></button>
              <button className="tool-card" type="button" onClick={() => setView("library")}><span className="tool-icon">♡</span><span><strong>Your library</strong><small>{savedTracks.length} saved {savedTracks.length === 1 ? "track" : "tracks"}</small></span><span className="tool-arrow">↗</span></button>
            </div>
          </section>
        ) : null}

        <section className="section">
          <div className="section-heading"><div><p className="eyebrow">{view === "library" ? "Saved on this device" : activeQuery ? "Search results" : "Picked for you"}</p><h2>{view === "library" ? "Your offline library" : activeQuery ? `Results for “${activeQuery}”` : "Made for your listening"}</h2></div><span>{visibleTracks.length} {visibleTracks.length === 1 ? "track" : "tracks"}</span></div>
          {loading ? <div className="empty loading">Loading your music…</div> : error ? <div className="error">{error}</div> : visibleTracks.length ? <div className="track-grid">{visibleTracks.map(renderTrack)}</div> : <div className="empty">No tracks here yet. Search for an artist or song above.</div>}
        </section>
      </main>

      {selected ? (
        <section className="player-screen" id="sonora-player-screen" aria-label="Full-screen music player">
          <div className="player-topbar"><button className="player-back" type="button" onClick={closePlayer} aria-label="Close player">⌄</button><span>SONORA PLAYER</span><button className="player-fullscreen" type="button" onClick={toggleFullScreen} aria-label="Toggle fullscreen">⛶</button></div>
          <div className="player-content">
            <div className="player-video">{offlineUrl ? <audio ref={offlineAudioRef} src={offlineUrl} autoPlay onLoadedMetadata={(event) => setCurrentTime(event.currentTarget.currentTime)} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onEnded={() => { setIsPlaying(false); setCurrentTime(0); }} /> : <iframe ref={playerFrameRef} id="sonora-youtube-player" src={`https://www.youtube.com/embed/${selected.id}?autoplay=1&playsinline=1&rel=0&controls=0&enablejsapi=1&cc_load_policy=${captionsEnabled ? 1 : 0}&cc_lang_pref=en`} title={selected.name} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />}</div>
            <div className="lyrics-panel"><div className="lyrics-heading"><span className="eyebrow">Lyrics</span><span className="caption-badge">{lyricsState === "ready" ? `SYNCED · ${lyricsSource === "youtube" ? "YOUTUBE" : "LRCLIB"}` : captionsEnabled ? "YOUTUBE CC" : "CC OFF"}</span></div>{lyricsState === "loading" ? <div className="lyrics-empty"><span className="lyrics-mark">♪</span><h2>Finding the lyrics…</h2><p>Matching this track by artist, title, and duration.</p></div> : lyricsState === "ready" ? <div className="lyrics-scroll" aria-live="polite">{lyrics.map((line, index) => <p className={`lyric-line ${index === activeLyricIndex ? "active" : index < activeLyricIndex ? "past" : ""}`} key={`${line.time}-${index}`}>{line.text}</p>)}</div> : lyricsState === "plain" ? <div className="lyrics-scroll plain-lyrics" aria-live="polite">{lyrics.map((line, index) => <p className="lyric-line" key={`${line.text}-${index}`}>{line.text}</p>)}</div> : <div className="lyrics-empty"><span className="lyrics-mark">CC</span><h2>{lyricsState === "missing" ? "No synced lyrics found" : "Synced words will appear here"}</h2><p>{lyricsSource === "youtube" ? "YouTube captions remain available inside the official player when provided." : "Try another version of this track or add a licensed LRC file later."}</p></div>}</div>
          </div>
          <div className="player-info"><div><p className="eyebrow">Now playing</p><h1>{selected.name}</h1><p>{selected.artist_name}</p></div><a href={selected.shareurl} target="_blank" rel="noreferrer">Open source ↗</a></div>
          <div className="player-controls"><div className="progress-line"><span>{formatTime(currentTime)}</span><input aria-label="Track progress" type="range" min="0" max={selected.duration || 1} value={Math.min(currentTime, selected.duration || 1)} onChange={(event) => seekTo(Number(event.target.value))} /><span>{formatTime(selected.duration)}</span></div><div className="control-row"><button type="button" onClick={() => seekBy(-10)} aria-label="Back ten seconds">↶<small>10</small></button><button type="button" onClick={() => seekBy(-30)} aria-label="Previous thirty seconds">⏮</button><button className="main-play" type="button" onClick={togglePlayback} aria-label={isPlaying ? "Pause" : "Play"}>{isPlaying ? "Ⅱ" : "▶"}</button><button type="button" onClick={() => seekBy(30)} aria-label="Next thirty seconds">⏭</button><button type="button" onClick={() => seekBy(10)} aria-label="Forward ten seconds">↷<small>10</small></button></div><div className="control-bottom"><button type="button" className={captionsEnabled ? "control-active" : ""} onClick={() => setCaptionsEnabled(!captionsEnabled)}>CC Subtitles</button><label>Volume <input aria-label="Volume" type="range" min="0" max="100" value={volume} onChange={(event) => setPlayerVolume(Number(event.target.value))} /></label><button type="button" onClick={toggleFullScreen}>⛶ Fullscreen</button></div></div>
        </section>
      ) : null}
      <input ref={importInputRef} type="file" accept="audio/*" hidden onChange={handleOfflineFile} />
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}
