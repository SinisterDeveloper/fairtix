'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { loadEventMeta } from '@/lib/event-meta';
import { formatWeiToInr } from '@/lib/format';
import type { DemoStatusResponse } from '@/lib/types';

export default function Home() {
  const [status, setStatus] = useState<DemoStatusResponse | null>(null);
  const [error, setError] = useState('');
  const [eventMeta, setEventMeta] = useState(loadEventMeta);

  useEffect(() => {
    setEventMeta(loadEventMeta());
    fetch('/api/status', { cache: 'no-store' })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok || data.ok === false) throw new Error(data.error || 'Event service not initialized.');
        setStatus(data);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load live event status.'));
  }, []);

  return (
    <main className="page">
      <section className="hero-panel">
        <p className="eyebrow">FAIRTICKETS · ANTI-SCALPING EVENT PLATFORM</p>
        <h1>Fair tickets. Zero scalping. Verified entry.</h1>
        <p className="hero-lead">
          Queue-first ticket allocation, capped face-value resale, and one-time venue check-in—split
          into three dedicated zones for fans, organisers/gate staff, and platform admins.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>{eventMeta.title}</h2>
            <p className="meta" style={{ margin: 0 }}>
              {eventMeta.venue} · {eventMeta.dateLabel}
            </p>
          </div>
          {status ? (
            <span className="pill ok">Stage: {status.phase}</span>
          ) : (
            <span className="pill warn">{error ? 'Waiting for event' : 'Connecting…'}</span>
          )}
        </div>
        {status ? (
          <div className="metrics-grid">
            <div className="metric">
              <span>Current stage</span>
              <strong>{status.phase}</strong>
            </div>
            <div className="metric">
              <span>Queue entries</span>
              <strong>{status.entrantsCount}</strong>
            </div>
            <div className="metric">
              <span>Tickets issued</span>
              <strong>
                {status.issuedCount} / {status.capacity}
              </strong>
            </div>
            <div className="metric">
              <span>Checked in at gate</span>
              <strong>{status.admittedCount}</strong>
            </div>
            <div className="metric">
              <span>Ticket price</span>
              <strong>{formatWeiToInr(status.facePriceWei, status.facePriceWei, status.facePriceInr)}</strong>
            </div>
          </div>
        ) : (
          <p>{error || 'Loading live event state…'}</p>
        )}
      </section>

      <section className="role-cards">
        <article className="card">
          <p className="eyebrow">ZONE 1 · USER (FAN)</p>
          <h2>Fan Bookings</h2>
          <p>
            Browse upcoming events, join the booking queue, claim your ticket at face value, trade on
            capped resale, and access your entry pass.
          </p>
          <div className="actions">
            <Link className="button" href="/fan">
              Open User Zone
            </Link>
          </div>
        </article>

        <article className="card">
          <p className="eyebrow">ZONE 2 · ORGANISER &amp; GATE</p>
          <h2>Event &amp; Gate Ops</h2>
          <p>
            Create events, set ticket capacity, open and lock the booking queue, finalize
            reservations, advance event stages, and scan passes at the venue gate.
          </p>
          <div className="actions">
            <Link className="button secondary" href="/organiser">
              Open Organiser
            </Link>
            <Link className="button secondary" href="/gate">
              Gate Scanner
            </Link>
          </div>
        </article>

        <article className="card">
          <p className="eyebrow">ZONE 3 · ADMIN</p>
          <h2>Backend &amp; Audit Logs</h2>
          <p>
            Inspect live backend activity logs, contract/hash telemetry, reconciled role credits,
            review-only security alerts, and adversarial bot simulations.
          </p>
          <div className="actions">
            <Link className="button secondary" href="/admin">
              Open Admin Zone
            </Link>
            <Link className="button secondary" href="/attack">
              Bot Simulator
            </Link>
          </div>
        </article>
      </section>
    </main>
  );
}
