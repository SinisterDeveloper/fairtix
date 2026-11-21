'use client';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export default function QrPassCard({
  credential,
  label,
}: {
  credential: Record<string, unknown> | null;
  label?: string;
}) {
  const [dataUrl, setDataUrl] = useState('');
  const payload = credential && credential.slot !== undefined ? JSON.stringify(credential) : '';

  useEffect(() => {
    if (!payload) {
      setDataUrl('');
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(payload, {
      width: 220,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#17201f', light: '#ffffff' },
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl('');
      });
    return () => {
      cancelled = true;
    };
  }, [payload]);

  if (!credential || credential.slot === undefined) {
    return (
      <div className="qr-box">
        <p className="meta" style={{ margin: 0 }}>
          No QR pass selected yet.
        </p>
      </div>
    );
  }

  return (
    <div className="qr-box">
      {dataUrl ? (
        <img
          src={dataUrl}
          width={200}
          height={200}
          alt={`QR pass for Seat #${String(credential.slot)} v${String(credential.version)}`}
          style={{ borderRadius: 10, border: '1px solid #dfe6e2', background: '#fff' }}
        />
      ) : (
        <p className="meta">Generating QR…</p>
      )}
      <div style={{ textAlign: 'center' }}>
        <strong>{label || `Seat #${String(credential.slot)} · Pass v${String(credential.version)}`}</strong>
        <div className="meta">
          Seat #{String(credential.slot)} · v{String(credential.version)}
        </div>
      </div>
    </div>
  );
}
