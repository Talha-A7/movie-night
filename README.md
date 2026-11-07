# 🍿 Movie Night

Watch a movie together from far away. The host plays a movie file (or shares their screen) and the partner watches live, with shared play/pause/seek, chat and emoji reactions.

- **Next.js** app (App Router)
- **Supabase Realtime** — Broadcast for chat, reactions, playback controls and WebRTC signaling; Presence for who's in the room. No database tables.
- **WebRTC** — the actual video/audio goes browser-to-browser.
- **TURN relay (optional, recommended)** — served by `/api/ice` so the provider key stays on the server.

## Setup

1. `npm install`
2. `cp .env.example .env.local` and fill in:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — Supabase dashboard → Project Settings → API.
     In Realtime settings, make sure public channels are allowed.
   - `METERED_APP` / `METERED_API_KEY` (free at https://dashboard.metered.ca) **or** `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL`.
     Without a relay, people on strict networks (most mobile data, many routers) can't receive the video.
3. `npm run dev` → http://localhost:3000

## Deploy (Vercel)

Import the GitHub repo in Vercel (or `vercel --prod`) and add the same environment variables in Project → Settings → Environment Variables.

## Tips

- Use Chrome or Edge on both ends.
- Movie files: MP4 (H.264 + AAC) or WebM work best. Some MKVs won't play in the browser — convert with HandBrake.
- Netflix/Disney+ etc. show a black screen when screen-shared (DRM).
