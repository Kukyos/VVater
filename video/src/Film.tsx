import React from 'react';
import {
  AbsoluteFill, Audio, OffthreadVideo, Sequence, Series, interpolate, staticFile,
  useCurrentFrame, useVideoConfig,
} from 'remotion';
import script from '../script.json';
import voice from './voice.json';
import { bands, qc, evidence, harnessCommand, repo, live } from './data';

// Near-black ground, one idea per card, light type, one accent: the viewer's own cyan.
const C = { ground: '#05080C', ink: '#F2F4F7', dim: '#8C94A1', faint: '#4A525E', accent: '#38BDF8', warn: '#F59E0B' };
const FONT = 'Inter';
export const FPS = 30;

type Clip = { name: string; seconds: number };
type Scene = {
  id: string; act: string; say: string; card?: string; seconds?: number; clips?: Clip[];
  lower?: string; lowers?: string[]; quote?: string; cite?: string; lines?: string[]; lowerAt?: 'left' | 'right' | 'center';
};
const scenes = script.scenes as Scene[];

// A scene is as long as its clips, or its card's seconds. Nothing is a hand-counted frame.
const frames = (s: Scene) =>
  Math.round(FPS * (s.clips ? s.clips.reduce((n, c) => n + c.seconds, 0) : s.seconds!));
export const TOTAL = scenes.reduce((n, s) => n + frames(s), 0);

const Fade: React.FC<{ children: React.ReactNode; dur: number; edge?: number }> = ({ children, dur, edge = 10 }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, edge, dur - edge, dur], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

// Rises in after `at` frames.
const Rise: React.FC<{ at?: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ at = 0, children, style }) => {
  const f = useCurrentFrame();
  const t = interpolate(f, [at, at + 18], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <div style={{ opacity: t, transform: `translateY(${(1 - t) * 14}px)`, ...style }}>{children}</div>;
};

// ------------------------------------------------------------------ over the footage

// Bottom-left, clear of the viewer's timeline and status bar; right or centre where a dock or
// the lesson card sits there.
const Lower: React.FC<{ act: string; text?: string; dur: number; at?: Scene['lowerAt'] }> = ({ act, text, dur, at = 'left' }) => {
  if (!act && !text) return null;
  const place: React.CSSProperties = at === 'right' ? { right: 56 } : at === 'center' ? { left: '50%', transform: 'translateX(-50%)' } : { left: 56 };
  return (
    <Sequence from={12} durationInFrames={Math.max(1, dur - 12)} layout="none">
      <Fade dur={dur - 12} edge={12}>
        <div style={{ position: 'absolute', ...place, bottom: 96, maxWidth: 1100, background: 'rgba(5,8,12,0.82)',
          borderLeft: `3px solid ${C.accent}`, padding: '14px 22px', fontFamily: FONT }}>
          {act && <div style={{ color: C.accent, fontSize: 17, letterSpacing: '0.18em', textTransform: 'uppercase', fontWeight: 500 }}>{act}</div>}
          {text && <div style={{ color: C.ink, fontSize: 27, fontWeight: 400, marginTop: act ? 6 : 0 }}>{text}</div>}
        </div>
      </Fade>
    </Sequence>
  );
};

const Footage: React.FC<{ s: Scene }> = ({ s }) => {
  let at = 0;
  return (
    <AbsoluteFill style={{ background: C.ground }}>
      {s.clips!.map((c, i) => {
        const d = Math.round(c.seconds * FPS);
        const el = (
          <Sequence key={c.name} from={at} durationInFrames={d}>
            <Fade dur={d} edge={s.clips!.length > 1 ? 6 : 10}>
              <OffthreadVideo src={staticFile(`clips/${c.name}.mp4`)} muted />
            </Fade>
            <Lower act={i === 0 || s.lowers ? s.act : ''} text={s.lowers ? s.lowers[i] : i === 0 ? s.lower : undefined} dur={d} at={s.lowerAt} />
          </Sequence>
        );
        at += d;
        return el;
      })}
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ cards

const Card: React.FC<{ children: React.ReactNode; act?: string }> = ({ children, act }) => (
  <AbsoluteFill style={{ background: C.ground, fontFamily: FONT, color: C.ink, padding: '120px 160px', justifyContent: 'center' }}>
    {act && <Rise><div style={{ color: C.accent, fontSize: 20, letterSpacing: '0.2em', textTransform: 'uppercase', fontWeight: 500, marginBottom: 36 }}>{act}</div></Rise>}
    {children}
  </AbsoluteFill>
);

const Title: React.FC = () => (
  <Card>
    <Rise><div style={{ fontSize: 168, fontWeight: 200, letterSpacing: '-0.04em' }}>VVater</div></Rise>
    <Rise at={20}><div style={{ fontSize: 44, fontWeight: 300, color: C.dim, marginTop: 8 }}>The ocean, from the side.</div></Rise>
    <Rise at={40}><div style={{ fontSize: 22, color: C.faint, marginTop: 72, letterSpacing: '0.06em' }}>
      SIH 2026 · PS 26067 · INCOIS, Ministry of Earth Sciences · Disaster Management</div></Rise>
  </Card>
);

const Quote: React.FC<{ s: Scene }> = ({ s }) => (
  <Card act={s.act}>
    <Rise at={8}><div style={{ fontSize: 54, fontWeight: 300, lineHeight: 1.3, maxWidth: 1500 }}>“{s.quote}”</div></Rise>
    <Rise at={30}><div style={{ fontSize: 24, color: C.dim, marginTop: 48 }}>{s.cite}</div></Rise>
  </Card>
);

// RMSE by depth band, bars to scale: the assimilated floats against the independent glider.
const Bands: React.FC<{ s: Scene }> = ({ s }) => {
  const f = useCurrentFrame();
  const max = Math.max(...bands.map((b) => Math.max(b.argo, b.glider)));
  const W = 900;
  const bar = (v: number, color: string, at: number) => {
    const t = interpolate(f, [at, at + 24], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    return <div style={{ height: 26, width: (v / max) * W * t, background: color, borderRadius: 2 }} />;
  };
  return (
    <Card act={s.act}>
      <Rise><div style={{ fontSize: 50, fontWeight: 300, marginBottom: 56 }}>Model error by depth, RMSE °C</div></Rise>
      {bands.map((b, i) => (
        <div key={b.band} style={{ display: 'flex', alignItems: 'center', marginBottom: 40 }}>
          <div style={{ width: 240, fontSize: 30, color: C.dim }}>{b.band}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>{bar(b.argo, C.faint, 20 + i * 12)}
              <span style={{ fontSize: 26, color: C.dim }}>{b.argoLabel}</span></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>{bar(b.glider, i === 0 ? C.warn : C.accent, 26 + i * 12)}
              <span style={{ fontSize: 26, color: i === 0 ? C.warn : C.ink, fontWeight: i === 0 ? 600 : 400 }}>{b.gliderLabel}</span></div>
          </div>
        </div>
      ))}
      <Rise at={70}><div style={{ fontSize: 22, color: C.dim, marginTop: 16, display: 'flex', gap: 40 }}>
        <span><span style={{ color: C.faint }}>■</span> Argo, assimilated: a consistency check</span>
        <span><span style={{ color: C.accent }}>■</span> Glider ru29, independent</span>
        <span style={{ color: C.faint }}>{s.lines![0]}</span>
      </div></Rise>
    </Card>
  );
};

const QC: React.FC<{ s: Scene }> = ({ s }) => (
  <Card act={s.act}>
    <Rise at={6}><div style={{ fontSize: 200, fontWeight: 200, color: C.warn, letterSpacing: '-0.03em' }}>{qc.max} °C</div></Rise>
    <Rise at={24}><div style={{ fontSize: 40, fontWeight: 300, marginTop: 4 }}>{s.lines![0]}</div></Rise>
    <Rise at={60}><div style={{ fontSize: 28, color: C.dim, marginTop: 56, lineHeight: 1.6 }}>
      Argo global range test ({qc.lo} to {qc.hi} °C): <span style={{ color: C.ink }}>{qc.failed} of {qc.checked} cells fail, masked</span><br />
      {s.lines![1]}
    </div></Rise>
  </Card>
);

const Evidence: React.FC<{ s: Scene }> = ({ s }) => (
  <Card act={s.act}>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '56px 64px' }}>
      {evidence.map((x, i) => (
        <Rise key={x.label} at={8 + i * 8}>
          <div style={{ fontSize: 84, fontWeight: 200, color: C.accent, letterSpacing: '-0.02em' }}>{x.value}</div>
          <div style={{ fontSize: 24, color: C.dim, marginTop: 6 }}>{x.label}</div>
        </Rise>
      ))}
    </div>
    <Rise at={70}><div style={{ fontSize: 26, color: C.dim, marginTop: 80, fontFamily: 'Consolas, monospace' }}>
      {repo} · <span style={{ color: C.ink }}>{harnessCommand}</span></div></Rise>
  </Card>
);

const NotYet: React.FC<{ s: Scene }> = ({ s }) => {
  const rows = s.lines!.map((l) => l.split('|'));
  return (
    <Card act={s.act}>
      {rows.map(([h, t], i) => (
        <Rise key={h} at={10 + i * 90}>
          <div style={{ marginBottom: 52 }}>
            <div style={{ fontSize: 50, fontWeight: 300 }}>{h}</div>
            <div style={{ fontSize: 28, color: C.dim, marginTop: 8 }}>{t}</div>
          </div>
        </Rise>
      ))}
    </Card>
  );
};

const End: React.FC = () => (
  <Card>
    <Rise><div style={{ fontSize: 150, fontWeight: 200, letterSpacing: '-0.04em' }}>VVater</div></Rise>
    <Rise at={18}><div style={{ fontSize: 56, fontWeight: 300, color: C.accent, marginTop: 12 }}>{live}</div></Rise>
    <Rise at={30}><div style={{ fontSize: 30, color: C.dim, marginTop: 20, fontFamily: 'Consolas, monospace' }}>{repo}</div></Rise>
    <Rise at={48}><div style={{ fontSize: 22, color: C.faint, marginTop: 72, letterSpacing: '0.06em' }}>
      Team K26125 · SIH 2026 · PS 26067 · INCOIS, Ministry of Earth Sciences</div></Rise>
  </Card>
);

const CARDS: Record<string, React.FC<{ s: Scene }>> = {
  title: Title, quote: Quote, bands: Bands, qc: QC, evidence: Evidence, notyet: NotYet, end: End,
};

// ------------------------------------------------------------------ the film

// A recorded line, public/voice/<scene>.<ext>, plays from half a second into its scene.
// check.mjs finds them and writes voice.json; it fails if a line runs past its scene.
const VOICE = voice as Record<string, string>;

export const Film: React.FC = () => {
  useVideoConfig();
  return (
    <AbsoluteFill style={{ background: C.ground }}>
      <Series>
        {scenes.map((s) => {
          const d = frames(s);
          const Body = s.card ? CARDS[s.card] : null;
          return (
            <Series.Sequence key={s.id} durationInFrames={d}>
              {Body ? <Fade dur={d}><Body s={s} /></Fade> : <Footage s={s} />}
              {VOICE[s.id] && (
                <Sequence from={Math.round(0.5 * FPS)} layout="none"><Audio src={staticFile(`voice/${VOICE[s.id]}`)} /></Sequence>
              )}
            </Series.Sequence>
          );
        })}
      </Series>
    </AbsoluteFill>
  );
};
