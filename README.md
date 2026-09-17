# Sonora

A Spotify-inspired, original music platform powered by YouTube discovery and official embedded playback.

## Features

- YouTube search across current music videos, artists, and songs
- Server-side YouTube Data API search so the API key never reaches the browser
- Official YouTube embedded playback for selected videos
- Persistent bottom player with YouTube controls
- Saved tracks stored locally in the browser
- Responsive dark interface with original Sonora branding

## YouTube API setup

1. Create or select a project in Google Cloud Console.
2. Enable **YouTube Data API v3**.
3. Create an API key and restrict it to YouTube Data API v3 and your development/deployment domains.
4. Put the key in `.env.local`:

```env
YOUTUBE_API_KEY=your_key_here
```

The API is used only to search for videos and read metadata. Sonora plays selected videos through YouTube's official embedded player. It does not download, extract, convert, or archive YouTube audio.

## Local setup

```bash
npm install
npm run dev
```

The app runs at `http://localhost:3000`.

## Notes

Search coverage depends on videos being available and embeddable in the user's country. YouTube API quota and YouTube's API Terms and Developer Policies apply.
