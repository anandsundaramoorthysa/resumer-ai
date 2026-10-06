import { ImageResponse } from 'next/og';

export const alt = 'Resumer AI: one profile, every role, no invented facts';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// No external fetches: system serif/mono fallbacks only.
const INK = '#1B1A17';
const BRAND = '#B8301A';
const line = (w: number, bg = '#D9D0BD') => (
  <div style={{ display: 'flex', width: w, height: 12, background: bg, marginBottom: 14 }} />
);

export default function Image() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', background: '#FFFFFF', padding: 64, color: INK }}>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, justifyContent: 'center', paddingRight: 48 }}>
          <div style={{ display: 'flex', fontSize: 24, letterSpacing: 4, color: '#5E574A', fontFamily: 'monospace' }}>
            RESUMER AI
          </div>
          <div style={{ display: 'flex', fontSize: 76, lineHeight: 1.05, marginTop: 24, fontFamily: 'serif' }}>
            One profile. Every role. No invented facts.
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: 400,
            background: '#FFFFFF',
            border: '2px solid #D9D0BD',
            boxShadow: '10px 12px 0 rgba(27,26,23,0.12)',
            padding: 36,
            transform: 'rotate(0.8deg)',
            position: 'relative',
          }}
        >
          <div style={{ display: 'flex', fontSize: 34, fontFamily: 'serif', marginBottom: 20 }}>Ada Lovelace</div>
          {line(300, '#F2D95C')}
          {line(340)}
          <div style={{ display: 'flex', width: 280, height: 12, background: '#D9D0BD', marginBottom: 14, position: 'relative' }}>
            <div style={{ display: 'flex', position: 'absolute', top: 5, left: -4, width: 288, height: 3, background: BRAND }} />
          </div>
          {line(320)}
          {line(240, '#F2D95C')}
          {line(330)}
          <div
            style={{
              display: 'flex',
              position: 'absolute',
              right: 24,
              bottom: 28,
              padding: '6px 16px',
              border: `4px solid ${BRAND}`,
              color: BRAND,
              fontSize: 40,
              fontFamily: 'monospace',
              transform: 'rotate(-6deg)',
            }}
          >
            8.7 VERIFIED
          </div>
        </div>
      </div>
    ),
    size,
  );
}
