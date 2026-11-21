'use client';

function buildMatrix(seedText: string): boolean[][] {
  const size = 21;
  const grid: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));

  const drawFinder = (r0: number, c0: number) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const center = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        grid[r0 + r][c0 + c] = edge || center;
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  let hash = 2166136261;
  for (let i = 0; i < seedText.length; i++) {
    hash ^= seedText.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const inTopLeft = r < 8 && c < 8;
      const inTopRight = r < 8 && c >= size - 8;
      const inBottomLeft = r >= size - 8 && c < 8;
      if (inTopLeft || inTopRight || inBottomLeft) continue;
      hash ^= (r * 31 + c * 17) & 0xff;
      hash = Math.imul(hash, 16777619);
      grid[r][c] = (hash >>> 0) % 2 === 0;
    }
  }

  return grid;
}

export default function QrPassCard({
  credential,
  label,
}: {
  credential: Record<string, unknown> | null;
  label?: string;
}) {
  if (!credential || credential.slot === undefined) {
    return (
      <div className="qr-box">
        <p className="meta" style={{ margin: 0 }}>
          No QR pass selected yet.
        </p>
      </div>
    );
  }

  const seed = `${credential.contract || ''}:${credential.slot}:${credential.version}:${credential.expiry}:${credential.ownerSig || ''}`;
  const matrix = buildMatrix(seed);

  return (
    <div className="qr-box">
      <svg
        width="156"
        height="156"
        viewBox="0 0 21 21"
        role="img"
        aria-label={`QR pass for Seat #${String(credential.slot)} v${String(credential.version)}`}
        style={{ background: '#fff', padding: 8, borderRadius: 10, border: '1px solid #dfe6e2' }}
      >
        {matrix.map((row, r) =>
          row.map((on, c) =>
            on ? <rect key={`${r}-${c}`} x={c} y={r} width="1" height="1" fill="#17201f" /> : null,
          ),
        )}
      </svg>
      <div style={{ textAlign: 'center' }}>
        <strong>{label || `Seat #${String(credential.slot)} · Pass v${String(credential.version)}`}</strong>
        <div className="meta">
          Seat #{String(credential.slot)} · v{String(credential.version)}
        </div>
      </div>
    </div>
  );
}
