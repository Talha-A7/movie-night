'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, newRoomCode, type CtrlAction, type Mode, type PlaybackState } from '@/lib/room';
import { supabaseConfigured } from '@/lib/supabase';

type Line = { id: number; kind: 'msg' | 'sys'; from?: string; text: string; me?: boolean };
type Floaty = { id: number; emoji: string; left: number };
type Status = { text: string; kind: '' | 'ok' | 'err' };

const REACTIONS = ['❤️', '😂', '😱', '😭', '🍿', '😘'];
let nextId = 1;

const fmt = (sec: number) => {
  const s = Math.max(0, Math.floor(+sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};

export default function MovieNight() {
  // ---------- state ----------
  const [phase, setPhase] = useState<'lobby' | 'room'>('lobby');
  const [isHost, setIsHost] = useState(false);
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [status, setStatus] = useState<Status>({ text: 'Not connected', kind: '' });
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [floaties, setFloaties] = useState<Floaty[]>([]);
  const [placeholder, setPlaceholder] = useState<string | null>('Waiting…');
  const [mode, setMode] = useState<Mode>(null); // host: what I'm playing · viewer: what the host is playing
  const [play, setPlay] = useState({ paused: true, t: 0, dur: 0 });
  const [seekDrag, setSeekDrag] = useState<number | null>(null);
  const [needTap, setNeedTap] = useState(false);
  const [copied, setCopied] = useState(false);
  const [volume, setVolume] = useState(1);
  const [chatText, setChatText] = useState('');

  // ---------- refs (used inside Room callbacks, so they never go stale) ----------
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const roomRef = useRef<Room | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const urlRef = useRef<string | null>(null);
  const modeRef = useRef<Mode>(null);
  const nameRef = useRef('');
  const lastStateSent = useRef(0);

  useEffect(() => {
    try { setName(localStorage.getItem('mn-name') || ''); } catch {}
    const r = new URLSearchParams(window.location.search).get('room');
    if (r) setJoinCode(r.toUpperCase());
    return () => roomRef.current?.leave();
  }, []);
  useEffect(() => { messagesRef.current?.scrollTo(0, 1e9); }, [lines]);

  // ---------- chat helpers ----------
  const addLine = useCallback((l: Omit<Line, 'id'>) => setLines(p => [...p, { ...l, id: nextId++ }]), []);
  const sys = useCallback((text: string) => addLine({ kind: 'sys', text }), [addLine]);
  const floaty = useCallback((emoji: string) => {
    const id = nextId++;
    setFloaties(p => [...p, { id, emoji, left: 10 + Math.random() * 80 }]);
    setTimeout(() => setFloaties(p => p.filter(f => f.id !== id)), 2900);
  }, []);
  const announce = (text: string) => { sys(text); roomRef.current?.sys(text); };

  // ---------- host: playback sync ----------
  const pushState = (force = false) => {
    const v = videoRef.current, room = roomRef.current;
    if (!v || !room) return;
    let s: PlaybackState = { mode: modeRef.current };
    if (modeRef.current === 'file') {
      const p = { paused: v.paused, t: v.currentTime, dur: v.duration || 0 };
      setPlay(p);
      s = { ...s, ...p };
    }
    if (force || Date.now() - lastStateSent.current > 1000) {
      room.setState(s);
      lastStateSent.current = Date.now();
    }
  };

  const doCtrl = (action: CtrlAction, t: number | undefined, who: string) => {
    const v = videoRef.current;
    if (!v || modeRef.current !== 'file') return;
    if (action === 'toggle') {
      if (v.paused) { void v.play(); announce(`${who} pressed play ▶`); }
      else { v.pause(); announce(`${who} paused ⏸`); }
    } else {
      const target = action === 'skip' ? v.currentTime + (t ?? 0) : (t ?? 0);
      const to = Math.max(0, Math.min(target, v.duration || Infinity));
      v.currentTime = to;
      announce(`${who} jumped to ${fmt(to)}`);
    }
  };

  /** Pressed in this browser: host acts directly, viewer asks the host. */
  const control = (action: CtrlAction, t?: number) => {
    if (isHost) doCtrl(action, t, nameRef.current);
    else roomRef.current?.ctrl(action, t);
  };

  // ---------- viewer: incoming video ----------
  const showRemote = (s: MediaStream | null, reason?: string) => {
    const v = videoRef.current;
    if (!v) return;
    if (!s) {
      v.srcObject = null;
      setPlaceholder(reason ?? 'The host stopped the movie. Waiting…');
      return;
    }
    if (v.srcObject !== s) { v.srcObject = s; v.muted = false; }
    setPlaceholder(null);
    v.play().catch(() => setNeedTap(true));
  };

  // ---------- host: sources ----------
  const stopAll = (silent = false) => {
    const v = videoRef.current;
    modeRef.current = null; setMode(null);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    roomRef.current?.setStream(null);
    if (v) { v.pause(); v.srcObject = null; v.removeAttribute('src'); v.load(); }
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    if (!silent) {
      setPlaceholder('Nothing playing. Open a movie file or share your screen.');
      roomRef.current?.stopped();
    }
  };

  const openFile = (f: File) => {
    const v = videoRef.current;
    if (!v) return;
    stopAll(true);
    modeRef.current = 'file'; setMode('file');
    v.muted = false;
    urlRef.current = URL.createObjectURL(f);
    v.src = urlRef.current;
    setPlaceholder(null);
    v.addEventListener('loadedmetadata', () => {
      const el = v as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
      const s = el.captureStream?.() ?? el.mozCaptureStream?.();
      if (!s) { sys("⚠️ This browser can't stream a movie file — use Chrome or Edge."); return; }
      streamRef.current = s;
      // tracks can appear a moment later — re-send to viewers once they do
      let timer: ReturnType<typeof setTimeout>;
      s.onaddtrack = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { if (streamRef.current === s) roomRef.current?.setStream(s); }, 400);
      };
      roomRef.current?.setStream(s);
      pushState(true);
    }, { once: true });
    announce(`${nameRef.current} loaded “${f.name}” 🎬 — press ▶ when you're both ready!`);
  };

  const shareScreen = async () => {
    let s: MediaStream;
    try {
      s = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
      } as DisplayMediaStreamOptions);
    } catch {
      sys('Screen share was cancelled.');
      return;
    }
    stopAll(true);
    streamRef.current = s;
    modeRef.current = 'screen'; setMode('screen');
    const vt = s.getVideoTracks()[0];
    if (vt) {
      vt.contentHint = 'motion';
      vt.onended = () => { if (streamRef.current === s) stopAll(); };
    }
    if (!s.getAudioTracks().length) sys('⚠️ No audio is being shared! Stop, share again, and tick "Share tab audio".');
    const v = videoRef.current!;
    v.srcObject = s; v.muted = true; // muted preview so the sound doesn't double up
    void v.play().catch(() => {});
    setPlaceholder(null);
    roomRef.current?.setStream(s);
    pushState(true);
    announce(`${nameRef.current} started sharing their screen 🎬`);
  };

  // ---------- joining ----------
  const start = async (host: boolean) => {
    const n = name.trim() || (host ? 'Host' : 'Guest');
    nameRef.current = n;
    try { localStorage.setItem('mn-name', n); } catch {}
    const code = host ? newRoomCode() : joinCode.trim().toUpperCase();
    if (!code) return;

    setBusy(true);
    setStatus({ text: host ? 'Creating room…' : 'Looking for the room…', kind: '' });
    const room = new Room(code, host ? 'host' : 'viewer', n, {
      status: (text, kind = '') => setStatus({ text, kind }),
      chat: (from, text) => addLine({ kind: 'msg', from, text }),
      sys,
      react: floaty,
      viewers: count => setStatus(count
        ? { text: `${count} watching 💕`, kind: 'ok' }
        : { text: 'Room open — waiting for your partner', kind: 'ok' }),
      viewerJoined: () => pushState(true),
      ctrl: doCtrl,
      remoteStream: showRemote,
      remoteState: s => {
        setMode(s.mode);
        if (s.mode === 'file') setPlay({ paused: !!s.paused, t: s.t ?? 0, dur: s.dur ?? 0 });
      },
    });
    roomRef.current = room;
    try {
      await room.connect();
    } catch (e) {
      room.leave();
      roomRef.current = null;
      setStatus({ text: (e as Error).message, kind: 'err' });
      setBusy(false);
      return;
    }
    setIsHost(host);
    setRoomCode(code);
    setPhase('room');
    setBusy(false);
    if (host) {
      setStatus({ text: 'Room open — waiting for your partner', kind: 'ok' });
      setPlaceholder('Hover here and click “Open movie file” to play a movie you can both pause and seek — or “Share screen” for anything else.');
      sys(`Room ${code} created. Copy the link and send it to your partner!`);
      if (!room.relay) sys('ℹ️ No relay (TURN) server configured — if your partner gets stuck connecting, add one (see README).');
    } else {
      setStatus({ text: 'In the room 💕', kind: 'ok' });
      setPlaceholder('Connected! Waiting for the host to start the movie…');
    }
  };

  // ---------- keyboard ----------
  const showControls = mode === 'file';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!showControls || (e.target as HTMLElement).matches('input, textarea')) return;
      if (e.code === 'Space') { e.preventDefault(); control('toggle'); }
      if (e.code === 'ArrowLeft') { e.preventDefault(); control('skip', -10); }
      if (e.code === 'ArrowRight') { e.preventDefault(); control('skip', 10); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const hostVideoEvent = (force: boolean) => () => { if (isHost && modeRef.current === 'file') pushState(force); };

  const copyLink = () => {
    void navigator.clipboard.writeText(`${window.location.origin}/?room=${roomCode}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const sendChat = (e: React.FormEvent) => {
    e.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    setChatText('');
    addLine({ kind: 'msg', from: nameRef.current, text, me: true });
    roomRef.current?.chat(text);
  };

  // ---------- render ----------
  return (
    <>
      <header>
        <h1>🍿 Movie <span>Night</span></h1>
        <div className={`status ${status.kind}`}>{status.text}</div>
      </header>

      {phase === 'lobby' && (
        <section className="lobby">
          {!supabaseConfigured && (
            <div className="card wide">
              <h2>⚙️ Almost ready</h2>
              <p>
                Connect a Supabase project: set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
                <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> in <code>.env.local</code> (or in Vercel’s
                environment variables), then restart.
              </p>
            </div>
          )}
          <div className="card">
            <h2>🎬 Host a movie</h2>
            <p>You play the movie or share your screen. You’ll get a link to send to your partner.</p>
            <input placeholder="Your name" maxLength={20} value={name} onChange={e => setName(e.target.value)} />
            <button className="primary" disabled={busy || !supabaseConfigured} onClick={() => start(true)}>Create room</button>
          </div>
          <div className="card">
            <h2>💌 Join a room</h2>
            <p>Open the link your partner sent, or type the code.</p>
            <input placeholder="Your name" maxLength={20} value={name} onChange={e => setName(e.target.value)} />
            <input placeholder="Room code (e.g. 4K7Q9)" maxLength={8} value={joinCode}
              onChange={e => setJoinCode(e.target.value.toUpperCase())}
              onKeyDown={e => { if (e.key === 'Enter') void start(false); }} />
            <button className="primary" disabled={busy || !supabaseConfigured || !joinCode.trim()} onClick={() => start(false)}>Join</button>
          </div>
        </section>
      )}

      <section className="room" hidden={phase !== 'room'}>
        <div className="stage" ref={stageRef}>
          <video
            ref={videoRef}
            playsInline
            autoPlay
            onPlay={hostVideoEvent(true)}
            onPause={hostVideoEvent(true)}
            onSeeked={hostVideoEvent(true)}
            onLoadedMetadata={hostVideoEvent(true)}
            onTimeUpdate={hostVideoEvent(false)}
            onError={() => {
              if (isHost && modeRef.current === 'file')
                sys("⚠️ Chrome can't play this file. MP4 (H.264 + AAC) or WebM works best — some MKVs won't play.");
            }}
          />
          {placeholder && (
            <div className="placeholder"><div className="big">🎞️</div><div>{placeholder}</div></div>
          )}
          <div className="floaties">
            {floaties.map(f => <div key={f.id} className="floaty" style={{ left: `${f.left}%` }}>{f.emoji}</div>)}
          </div>

          {isHost && (
            <div className="codebox">
              Room code: <b>{roomCode}</b>
              <button onClick={copyLink}>{copied ? 'Copied!' : 'Copy link'}</button>
            </div>
          )}

          {needTap && (
            <div className="tap">
              <button className="primary" onClick={() => { void videoRef.current?.play(); setNeedTap(false); }}>
                ▶ Click to start watching
              </button>
            </div>
          )}

          {showControls && (
            <div className={`controls overlay ${play.paused ? 'show' : ''}`}>
              <button title="Back 10s" onClick={() => control('skip', -10)}>⏪</button>
              <button title="Play / pause (space)" onClick={() => control('toggle')}>{play.paused ? '▶' : '⏸'}</button>
              <button title="Forward 10s" onClick={() => control('skip', 10)}>⏩</button>
              <input
                type="range" className="seek" min={0} max={play.dur || 0} step={0.1}
                value={seekDrag ?? play.t}
                onChange={e => setSeekDrag(+e.target.value)}
                onPointerUp={e => {
                  control('seek', +e.currentTarget.value);
                  setSeekDrag(null);
                  e.currentTarget.blur(); // give Space/arrow shortcuts back to the page
                }}
              />
              <span className="time">{fmt(seekDrag ?? play.t)} / {fmt(play.dur)}</span>
            </div>
          )}

          <div className="toolbar overlay">
            {isHost && (
              <>
                <button className="primary" onClick={() => fileInputRef.current?.click()}>🎞️ Open movie file</button>
                <button onClick={shareScreen}>🖥️ Share screen</button>
                {mode && <button onClick={() => stopAll()}>⏹ Stop</button>}
                <input ref={fileInputRef} type="file" accept="video/*,.mkv" hidden
                  onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) openFile(f); }} />
              </>
            )}
            <span className="spacer" />
            {!isHost && (
              <>
                <span>🔊</span>
                <input type="range" className="volume" min={0} max={1} step={0.01} value={volume}
                  onChange={e => { setVolume(+e.target.value); if (videoRef.current) videoRef.current.volume = +e.target.value; }} />
              </>
            )}
            <button onClick={() => document.fullscreenElement ? document.exitFullscreen() : stageRef.current?.requestFullscreen()}>
              ⛶ Fullscreen
            </button>
          </div>
        </div>

        <aside className="chat">
          <h3>💬 Chat</h3>
          <div className="messages" ref={messagesRef}>
            {lines.map(l => l.kind === 'sys'
              ? <div key={l.id} className="sys">{l.text}</div>
              : <div key={l.id} className={`msg ${l.me ? 'me' : ''}`}><small>{l.from}</small>{l.text}</div>)}
          </div>
          <div className="reactions">
            {REACTIONS.map(r => (
              <button key={r} onClick={() => { floaty(r); roomRef.current?.react(r); }}>{r}</button>
            ))}
          </div>
          <form className="chatform" onSubmit={sendChat}>
            <input placeholder="Say something…" autoComplete="off" value={chatText} onChange={e => setChatText(e.target.value)} />
            <button className="primary">Send</button>
          </form>
        </aside>
      </section>
    </>
  );
}
