'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { DEFAULT_EVENT_META, loadEventMeta } from '@/lib/event-meta';
import { formatWeiToInr } from '@/lib/format';
import type { DemoStatusResponse } from '@/lib/types';

function stageLabel(phase?: string): string {
  const p = (phase || '').toUpperCase();
  if (!p) return 'Connecting…';
  if (p.includes('ENTRY')) return 'Queue Open';
  if (p.includes('DRAW')) return 'Finalizing';
  if (p.includes('CLAIM')) return 'Claim Open';
  if (p.includes('RESALE')) return 'Resale Open';
  if (p.includes('GATE')) return 'Doors Open';
  return 'Ended';
}

export default function Home() {
  const [status, setStatus] = useState<DemoStatusResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [eventMeta, setEventMeta] = useState(DEFAULT_EVENT_META);

  useEffect(() => {
    setEventMeta(loadEventMeta());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    fetch('/api/status', { cache: 'no-store', signal: controller.signal })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok || data.ok === false) throw new Error(data.error || 'No active event.');
        setStatus(data);
      })
      .catch(() => setStatus(null))
      .finally(() => {
        clearTimeout(timer);
        setLoaded(true);
      });
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  const liveMeta = status?.eventMeta || eventMeta;
  const livePrice = status
    ? formatWeiToInr(status.facePriceWei, status.facePriceWei, status.facePriceInr)
    : '—';

  return (
    <main className="page">
      {status ? (
        <>
          <section className="bms-hero">
            <p className="eyebrow">FEATURED SHOW</p>
            <h1>{liveMeta.title}</h1>
            <p>
              {liveMeta.venue} · {liveMeta.dateLabel}
            </p>
            <div className="bms-hero-actions">
              <Link className="bms-btn-light" href="/fan">
                Book Tickets ({livePrice})
              </Link>
              <Link className="bms-btn-outline" href="/bookings">
                My Bookings
              </Link>
              <span className="pill ok">{stageLabel(status.phase)}</span>
            </div>
          </section>

          <section aria-label="Live events">
            <div className="card-head">
              <h2>Live Shows</h2>
              <span className="meta">Created by organisers</span>
            </div>
            <div className="shows-grid">
              <article className="show-card live">
                <div>
                  <div className="show-poster p1">
                    <span className="show-tag">LIVE NOW</span>
                    <strong>{stageLabel(status.phase)}</strong>
                  </div>
                  <h3>{liveMeta.title}</h3>
                  <p className="show-meta">
                    {liveMeta.venue} · {liveMeta.dateLabel}
                  </p>
                </div>
                <div className="show-footer">
                  <div>
                    <strong>{livePrice}</strong>
                    <div className="meta">
                      {status.issuedCount}/{status.capacity} booked
                    </div>
                  </div>
                  <Link className="button small-btn" href="/fan">
                    Book Now
                  </Link>
                </div>
              </article>
            </div>
          </section>
        </>
      ) : (
        <section className="card">
          <h2>{loaded ? 'No live events right now' : 'Loading shows…'}</h2>
          <p>
            {loaded
              ? 'An organiser can create and publish a new event from the Organisers section.'
              : 'Checking for active events…'}
          </p>
          {loaded && (
            <div className="actions" style={{ marginBottom: 0 }}>
              <Link className="button" href="/organiser">
                Create an Event
              </Link>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
