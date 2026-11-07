// Returns TURN relay servers for WebRTC, keeping the provider API key on the server.
export const dynamic = 'force-dynamic';

export async function GET() {
  const iceServers: RTCIceServer[] = [];

  const { METERED_APP, METERED_API_KEY, TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL } = process.env;

  if (METERED_APP && METERED_API_KEY) {
    try {
      const r = await fetch(
        `https://${METERED_APP}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED_API_KEY)}`,
        { cache: 'no-store' },
      );
      if (!r.ok) throw new Error(`Metered responded ${r.status}`);
      const servers = await r.json();
      if (Array.isArray(servers)) iceServers.push(...servers);
    } catch (e) {
      console.error('TURN credentials fetch failed:', e);
    }
  }

  if (TURN_URLS) {
    iceServers.push({
      urls: TURN_URLS.split(',').map(s => s.trim()).filter(Boolean),
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL,
    });
  }

  return Response.json({ iceServers }, { headers: { 'Cache-Control': 'no-store' } });
}
