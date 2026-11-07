import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const supabaseConfigured = Boolean(url && key);

let client: SupabaseClient | null = null;

/** Browser Supabase client — only Realtime is used (Broadcast + Presence), no database tables. */
export function getSupabase(): SupabaseClient {
  if (!url || !key) {
    throw new Error('Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.');
  }
  client ??= createClient(url, key, {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 50 } }, // WebRTC ICE candidates arrive in bursts
  });
  return client;
}
