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
  const [error, setError] = useState('');
  const [eventMeta, setEventMeta] = useState(DEFAULT_EVENT_META);

  useEffect(() => {
    setEventMeta(loadEventMeta());
    fetch('/api/status', { cache: 'no-store' })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok || data.ok === false) throw new Error(data.error || 'No active event right now.');
        setStatus(data);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load live shows.'));
  }, []);

  const livePrice = status
    ? formatWeiToInr(status.facePriceWei, status.facePriceWei, status.facePriceInr)
    : '₹3,000';

  return (
    <main className="page">
      <section className="bms-hero">
        <p className="eyebrow">FEATURED SHOW · LIVE BOOKING</p>
        <h1>{eventMeta.title}</h1>
        <p>
          {eventMeta.venue} · {eventMeta.dateLabel}. How it works: <strong>Click on event</strong> →{' '}
          <strong>Join Queue</strong> → <strong>Claim if selected</strong> →{' '}
          <strong>Go to My Bookings and get the QR to be shown at gate</strong>.
        </p>
        <div className="bms-hero-actions">
          <Link className="bms-btn-light" href="/fan">
            Book Tickets ({livePrice})
          </Link>
          <Link className="bms-btn-outline" href="/bookings">
            My Bookings &amp; Passes
          </Link>
          <span className="pill ok">{status ? stageLabel(status.phase) : error ? 'Offline' : 'Loading…'}</span>
        </div>
      </section>

      <section aria-label="Recommended shows">
        <div className="card-head">
          <h2>Recommended Shows</h2>
          <span className="meta">Select a show to join the queue or manage your tickets</span>
        </div>

        <div className="shows-grid">
          <article className="show-card live">
            <div>
              <div className="show-poster p1">
                <span className="show-tag">CONCERT · LIVE NOW</span>
                <strong>{status ? stageLabel(status.phase) : 'Live Event'}</strong>
              </div>
              <h3>{eventMeta.title}</h3>
              <p className="show-meta">
                {eventMeta.venue} · {eventMeta.dateLabel}
              </p>
            </div>
            <div className="show-footer">
              <div>
                <strong>{livePrice}</strong>
                <div className="meta">
                  {status ? `${status.issuedCount}/${status.capacity} booked` : 'Checking seats…'}
                </div>
              </div>
              <Link className="button small-btn" href="/fan">
                Book Now
              </Link>
            </div>
          </article>

          <article className="show-card">
            <div>
              <div className="show-poster p2">
                <span className="show-tag">LIVE MUSIC</span>
                <strong>Coming Soon</strong>
              </div>
              <h3>AR Rahman — Live in Concert</h3>
              <p className="show-meta">Jio World Garden, Mumbai · Next Month</p>
            </div>
            <div className="show-footer">
              <div>
                <strong>₹2,500</strong>
                <div className="meta">Queue opens soon</div>
              </div>
              <span className="pill">Notify Me</span>
            </div>
          </article>

          <article className="show-card">
            <div>
              <div className="show-poster p3">
                <span className="show-tag">FESTIVAL</span>
                <strong>Coming Soon</strong>
              </div>
              <h3>Sunburn Arena — Electronic Night</h3>
              <p className="show-meta">Mahalaxmi Racecourse, Mumbai · Upcoming</p>
            </div>
            <div className="show-footer">
              <div>
                <strong>₹1,800</strong>
                <div className="meta">Queue opens soon</div>
              </div>
              <span className="pill">Notify Me</span>
            </div>
          </article>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Organisers &amp; Platform Staff</h2>
            <p className="meta" style={{ margin: 0 }}>
              Create events, manage ticket capacity and phases, check in attendees, or inspect backend logs.
            </p>
          </div>
          <div className="actions" style={{ margin: 0 }}>
            <Link className="button secondary small-btn" href="/organiser">
              Organiser Console
            </Link>
            <Link className="button secondary small-btn" href="/gate">
              Gate Scanner
            </Link>
            <Link className="button secondary small-btn" href="/admin">
              Admin Logs
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
