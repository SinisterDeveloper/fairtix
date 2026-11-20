'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatWeiToEth } from '@/lib/format';
import type { DemoStatusResponse } from '@/lib/types';

export default function Home() {
  const [status, setStatus] = useState<DemoStatusResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/status', { cache: 'no-store' })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok || data.ok === false) throw new Error(data.error || 'Chain not initialized.');
        setStatus(data);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not reach local chain.'));
  }, []);

  return (
    <main className="page">
      <section className="hero-panel">
        <p className="eyebrow">FAIRTICKETS · LOCAL BLOCKCHAIN DEMO</p>
        <h1>Fair access. Tickets that cannot be scalped or faked.</h1>
        <p className="hero-lead">
          Every entry, lottery draw, price-capped resale, and venue admission is enforced directly by
          an immutable smart contract on the local Anvil chain—never a mutable database.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Live event status</h2>
          {status ? (
            <span className="pill ok">Phase: {status.phase}</span>
          ) : (
            <span className="pill warn">{error ? 'Waiting for demo chain' : 'Connecting…'}</span>
          )}
        </div>
        {status ? (
          <div className="metrics-grid">
            <div className="metric">
              <span>Current phase</span>
              <strong>{status.phase}</strong>
            </div>
            <div className="metric">
              <span>Entrants</span>
              <strong>{status.entrantsCount}</strong>
            </div>
            <div className="metric">
              <span>Tickets issued</span>
              <strong>
                {status.issuedCount} / {status.capacity}
              </strong>
            </div>
            <div className="metric">
              <span>Admitted at gate</span>
              <strong>{status.admittedCount}</strong>
            </div>
            <div className="metric">
              <span>Face price</span>
              <strong>{formatWeiToEth(status.facePriceWei)}</strong>
            </div>
          </div>
        ) : (
          <p>
            {error
              ? `${error} Make sure Anvil is running and run \`node src/cli.cjs init-demo\` to deploy the event.`
              : 'Loading live contract state…'}
          </p>
        )}
      </section>

      <section className="role-cards">
        <article className="card">
          <p className="eyebrow">1 · FOR FANS</p>
          <h2>Fan Portal</h2>
          <p>
            Register for the lottery as Fan A or Fan B, claim a winning ticket at face price, list or
            buy on capped resale, and sign a short-lived gate pass.
          </p>
          <div className="actions">
            <Link className="button" href="/fan">
              Open fan view
            </Link>
          </div>
        </article>

        <article className="card">
          <p className="eyebrow">2 · FOR ORGANISERS</p>
          <h2>Organiser Console</h2>
          <p>
            Advance the event through draw and claim phases, inspect contract hashes and reconciled
            balances, and monitor review-only suspicious activity alerts.
          </p>
          <div className="actions">
            <Link className="button secondary" href="/organiser">
              Open organiser view
            </Link>
          </div>
        </article>

        <article className="card">
          <p className="eyebrow">3 · AT THE VENUE</p>
          <h2>Gate Scanner</h2>
          <p>
            Verify a fan&apos;s cryptographic pass on-chain. Stale passes from resold tickets and
            duplicate scans are automatically rejected.
          </p>
          <div className="actions">
            <Link className="button secondary" href="/gate">
              Open gate scanner
            </Link>
          </div>
        </article>
      </section>

      <section className="card">
        <h2>How the end-to-end journey works</h2>
        <ol className="guide-list">
          <li>
            <strong>Enter the draw (Fan):</strong> On <Link href="/fan">/fan</Link>, register as{' '}
            <em>Fan A</em>, then switch to <em>Fan B</em> in the top-right selector and register.
            Duplicate entries are rejected on-chain.
          </li>
          <li>
            <strong>Lock &amp; run the draw (Organiser):</strong> On{' '}
            <Link href="/organiser">/organiser</Link>, close entry &amp; lock the draw, then run the
            draw to select winners.
          </li>
          <li>
            <strong>Claim &amp; test capped resale (Fan):</strong> On <Link href="/fan">/fan</Link>,
            claim the winning ticket, sign a <code>v1</code> gate pass, then try listing above the
            cap (rejected) before selling to the other fan at a valid price (creates <code>v2</code>).
          </li>
          <li>
            <strong>Verify at the gate (Gate):</strong> On <Link href="/gate">/gate</Link>, scan the
            seller&apos;s old <code>v1</code> pass (rejected as stale), then scan the buyer&apos;s{' '}
            <code>v2</code> pass (admitted once; repeat scan rejected).
          </li>
        </ol>
      </section>
    </main>
  );
}
