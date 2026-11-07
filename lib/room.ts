/**
 * Room = Supabase Realtime channel (signaling, chat, controls, presence)
 *      + WebRTC peer connections (the actual video/audio, host → each viewer).
 */
import type { RealtimeChannel } from '@supabase/supabase-js';
import { getSupabase } from './supabase';

export type Role = 'host' | 'viewer';
export type Mode = 'file' | 'screen' | null;
export type CtrlAction = 'toggle' | 'seek' | 'skip';
export type PlaybackState = { mode: Mode; paused?: boolean; t?: number; dur?: number };

export type RoomEvents = {
  status: (text: string, kind?: '' | 'ok' | 'err') => void;
  chat: (from: string, text: string) => void;
  sys: (text: string) => void;
  react: (emoji: string) => void;
  viewers: (count: number) => void;
  /** host: a viewer (re)joined — resend playback state */
  viewerJoined: () => void;
  /** host: a viewer pressed a playback control */
  ctrl: (action: CtrlAction, t: number | undefined, who: string) => void;
  /** viewer: incoming movie stream (null = nothing playing) */
  remoteStream: (s: MediaStream | null, reason?: string) => void;
  /** viewer: host's playback state */
  remoteState: (s: PlaybackState) => void;
};

export const NO_RELAY =
  'Your networks block direct connections, so a relay (TURN) server is needed — set METERED_APP / METERED_API_KEY.';

const STUN: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

export function newRoomCode() {
  const c = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

async function fetchIceServers(): Promise<{ servers: RTCIceServer[]; relay: boolean }> {
  try {
    const r = await fetch('/api/ice', { cache: 'no-store' });
    const j = await r.json();
    if (Array.isArray(j.iceServers) && j.iceServers.length) return { servers: [...STUN, ...j.iceServers], relay: true };
  } catch (e) {
    console.warn('Could not load TURN servers', e);
  }
  return { servers: STUN, relay: false };
}

/** Raise video bitrate so movies look sharp. */
function tuneSender(pc: RTCPeerConnection) {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue;
    const p = sender.getParameters();
    if (!p.encodings?.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = 8_000_000;
    p.encodings[0].maxFramerate = 30;
    (p as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = 'maintain-framerate';
    sender.setParameters(p).catch(() => {});
  }
}

type Signal = { type: 'signal'; to: string; from: string; sid: string; kind: 'offer' | 'answer' | 'ice'; data: any };
type Peer = { pc: RTCPeerConnection; sid: string; pending: RTCIceCandidateInit[] };
type Meta = { role: Role; name: string };

export class Room {
  readonly id = uid();
  relay = false;
  private ch: RealtimeChannel | null = null;
  private ice: RTCIceServer[] = STUN;
  private ready = false;
  private closed = false;

  // host side
  private stream: MediaStream | null = null;
  private peers = new Map<string, Peer>(); // viewerId → connection
  private lastState: PlaybackState = { mode: null };

  // viewer side
  private hostId: string | null = null;
  private vpeer: Peer | null = null;
  private earlyIce = new Map<string, RTCIceCandidateInit[]>(); // sid → candidates that beat their offer
  private connectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly code: string,
    readonly role: Role,
    readonly name: string,
    private on: RoomEvents,
  ) {}

  // ---------- lifecycle ----------
  async connect() {
    const { servers, relay } = await fetchIceServers();
    this.ice = servers;
    this.relay = relay;

    const ch = getSupabase().channel(`movienight:${this.code}`, {
      config: { broadcast: { self: false }, presence: { key: this.id } },
    });
    this.ch = ch;

    ch.on('broadcast', { event: 'msg' }, ({ payload }) => this.handle(payload));
    ch.on('presence', { event: 'sync' }, () => this.onPresenceSync());
    ch.on('presence', { event: 'leave' }, ({ key }) => this.onLeave(key));

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Could not reach Supabase Realtime (timed out).')), 15000);
      ch.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(t);
          if (this.ready) this.on.status('Reconnected', 'ok');
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(t);
          if (this.ready && !this.closed) this.on.status('Lost connection to the room server — reconnecting…', 'err');
          reject(new Error(`Supabase Realtime error: ${err?.message ?? status}`));
        }
      });
    });

    await ch.track({ role: this.role, name: this.name } satisfies Meta);

    if (this.role === 'viewer') {
      const host = await this.waitForHost(6000);
      if (!host) throw new Error("No room with that code — check it, and that the host's page is still open.");
      this.hostId = host;
      this.send({ type: 'hello', id: this.id, from: this.name });
    }
    this.ready = true;
  }

  leave() {
    this.closed = true;
    clearTimeout(this.connectTimer);
    for (const p of this.peers.values()) p.pc.close();
    this.peers.clear();
    this.vpeer?.pc.close();
    if (this.ch) getSupabase().removeChannel(this.ch);
    this.ch = null;
  }

  // ---------- messaging ----------
  private send(payload: Record<string, unknown>) {
    this.ch?.send({ type: 'broadcast', event: 'msg', payload });
  }
  private signal(to: string, sid: string, kind: Signal['kind'], data: unknown) {
    this.send({ type: 'signal', to, from: this.id, sid, kind, data });
  }
  chat(text: string) { this.send({ type: 'chat', from: this.name, text }); }
  react(emoji: string) { this.send({ type: 'react', emoji }); }
  sys(text: string) { this.send({ type: 'sys', text }); }
  /** viewer → host */
  ctrl(action: CtrlAction, t?: number) { this.send({ type: 'ctrl', action, t, from: this.name }); }
  /** host → viewers */
  setState(s: PlaybackState) { this.lastState = s; this.send({ type: 'state', ...s }); }
  stopped() { this.lastState = { mode: null }; this.send({ type: 'stopped' }); }

  private handle(m: any) {
    switch (m?.type) {
      case 'chat': return this.on.chat(m.from, m.text);
      case 'react': return this.on.react(m.emoji);
      case 'sys': return this.on.sys(m.text);
      case 'hello':
        if (this.role !== 'host') return;
        this.on.sys(`${m.from} joined 💕`);
        this.send({ type: 'state', ...this.lastState });
        this.on.viewerJoined();
        void this.offerTo(m.id);
        return;
      case 'state':
        if (this.role === 'viewer') this.on.remoteState(m);
        return;
      case 'stopped':
        if (this.role === 'viewer') { this.on.remoteState({ mode: null }); this.on.remoteStream(null); }
        return;
      case 'ctrl':
        if (this.role === 'host') this.on.ctrl(m.action, m.t, m.from);
        return;
      case 'signal':
        if (m.to === this.id) void this.handleSignal(m as Signal).catch(e => console.error('signal error', e));
        return;
    }
  }

  // ---------- presence ----------
  private presence(): Record<string, Meta[]> {
    return (this.ch?.presenceState() ?? {}) as unknown as Record<string, Meta[]>;
  }
  private findHost() {
    for (const [key, metas] of Object.entries(this.presence())) if (metas.some(m => m.role === 'host')) return key;
    return null;
  }
  private viewerIds() {
    return Object.entries(this.presence())
      .filter(([, metas]) => metas.some(m => m.role === 'viewer'))
      .map(([key]) => key);
  }
  private async waitForHost(ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const h = this.findHost();
      if (h) return h;
      await new Promise(r => setTimeout(r, 250));
    }
    return null;
  }
  private onPresenceSync() {
    if (this.role === 'host') this.on.viewers(this.viewerIds().length);
  }
  private onLeave(key: string) {
    if (this.role === 'host') {
      const p = this.peers.get(key);
      if (p) { p.pc.close(); this.peers.delete(key); this.on.sys('Your partner left'); }
    } else if (key === this.hostId) {
      this.vpeer?.pc.close(); this.vpeer = null;
      this.on.remoteState({ mode: null });
      this.on.remoteStream(null, 'The host left the room.');
      this.on.status('Host left the room', 'err');
    }
  }

  // ---------- WebRTC: host ----------
  /** Host: start/replace/stop the outgoing stream for every viewer. */
  setStream(s: MediaStream | null) {
    this.stream = s;
    if (!s) {
      for (const p of this.peers.values()) p.pc.close();
      this.peers.clear();
      return;
    }
    for (const id of this.viewerIds()) void this.offerTo(id);
  }

  private async offerTo(viewerId: string) {
    this.peers.get(viewerId)?.pc.close();
    this.peers.delete(viewerId);
    const s = this.stream;
    if (!s || !s.getTracks().length) return;

    const sid = uid();
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    const peer: Peer = { pc, sid, pending: [] };
    this.peers.set(viewerId, peer);

    s.getTracks().forEach(t => pc.addTrack(t, s));
    pc.onicecandidate = e => { if (e.candidate) this.signal(viewerId, sid, 'ice', e.candidate.toJSON()); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') tuneSender(pc);
      if (pc.connectionState === 'failed' && this.peers.get(viewerId) === peer)
        this.on.sys('❌ Video connection to your partner failed. ' + (this.relay ? 'Try stopping and starting again.' : NO_RELAY));
    };

    await pc.setLocalDescription(await pc.createOffer());
    this.signal(viewerId, sid, 'offer', pc.localDescription!.toJSON());
  }

  // ---------- WebRTC: both ----------
  private async handleSignal(m: Signal) {
    if (this.role === 'host') {
      const p = this.peers.get(m.from);
      if (!p || p.sid !== m.sid) return; // stale
      if (m.kind === 'answer') {
        await p.pc.setRemoteDescription(m.data);
        for (const c of p.pending.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
      } else if (m.kind === 'ice') {
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(m.data).catch(() => {});
        else p.pending.push(m.data);
      }
      return;
    }

    // viewer
    if (m.kind === 'offer') {
      this.vpeer?.pc.close();
      const pc = new RTCPeerConnection({ iceServers: this.ice });
      const peer: Peer = { pc, sid: m.sid, pending: this.earlyIce.get(m.sid) ?? [] };
      this.earlyIce.clear();
      this.vpeer = peer;
      this.hostId = m.from;

      pc.ontrack = e => this.on.remoteStream(e.streams[0] ?? new MediaStream([e.track]));
      pc.onicecandidate = e => { if (e.candidate) this.signal(m.from, m.sid, 'ice', e.candidate.toJSON()); };
      pc.onconnectionstatechange = () => {
        if (this.vpeer !== peer) return;
        if (pc.connectionState === 'connected') { clearTimeout(this.connectTimer); this.on.status('Connected 💕', 'ok'); }
        if (pc.connectionState === 'failed') {
          clearTimeout(this.connectTimer);
          this.on.status('Video connection failed. ' + (this.relay ? 'Ask the host to stop and restart the movie.' : NO_RELAY), 'err');
        }
      };
      this.on.status('Connecting to the movie…');
      clearTimeout(this.connectTimer);
      this.connectTimer = setTimeout(() => {
        if (this.vpeer === peer && pc.connectionState !== 'connected')
          this.on.status('Video is taking too long to connect. ' + (this.relay ? 'Check your internet.' : NO_RELAY), 'err');
      }, 20000);

      await pc.setRemoteDescription(m.data);
      for (const c of peer.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      await pc.setLocalDescription(await pc.createAnswer());
      this.signal(m.from, m.sid, 'answer', pc.localDescription!.toJSON());
    } else if (m.kind === 'ice') {
      const p = this.vpeer;
      if (p && p.sid === m.sid) {
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(m.data).catch(() => {});
        else p.pending.push(m.data);
      } else {
        const q = this.earlyIce.get(m.sid) ?? [];
        q.push(m.data);
        this.earlyIce.set(m.sid, q);
      }
    }
  }
}
