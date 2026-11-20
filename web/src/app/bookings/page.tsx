'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import TxStatusBanner from '@/components/TxStatusBanner';
import { DEFAULT_EVENT_META, loadEventMeta } from '@/lib/event-meta';
import { formatWeiToInr, inrToWei } from '@/lib/format';
import type { ApiMutationResponse, DemoStatusResponse, RoleId } from '@/lib/types';

export default function BookingsPage() {
  const [role, setRole] = useState<RoleId>('fanA');
  const [status, setStatus] = useState<DemoStatusResponse | null>(null);
  const [eventMeta, setEventMeta] = useState(DEFAULT_EVENT_META);
  const [price, setPrice] = useState('2400');
  const [tray, setTray] = useState<Array<Record<string, unknown>>>([]);
  const [message, setMessage] = useState<ApiMutationResponse | null>(null);
  const [statusError, setStatusError] = useState('');
  const [busy, setBusy] = useState(false);

  const isFan = role === 'fanA' || role === 'fanB';

  async function refresh() {
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      const data = await r.json();
      if (!r.ok || data.ok === false) throw new Error(data.error || 'Could not load bookings.');
      setStatus(data);
      setStatusError('');
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Could not load bookings.');
    }
  }

  useEffect(() => {
    setEventMeta(loadEventMeta());
    void refresh();
    const id = setInterval(refresh, 3000);
    try {
      const saved = localStorage.getItem('fairtickets-credentials');
      if (saved) setTray(JSON.parse(saved));
    } catch {
      localStorage.removeItem('fairtickets-credentials');
    }
    const onRole = (e: Event) => setRole((e as CustomEvent<RoleId>).detail);
    window.addEventListener('fairtickets-role-change', onRole);
    const active = localStorage.getItem('fairtickets-role') as RoleId | null;
    if (active) setRole(active);
    return () => {
      clearInterval(id);
      window.removeEventListener('fairtickets-role-change', onRole);
    };
  }, []);

  async function act(endpoint: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      const r = await fetch(`/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role, ...body }),
      });
      setMessage((await r.json()) as ApiMutationResponse);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function signPass(slot: number, version: number) {
    setBusy(true);
    try {
      const inGate = status?.phase?.toUpperCase().includes('GATE');
      const expirySeconds = !inGate && status?.resaleCutoff ? status.resaleCutoff + 60 : undefined;
      const r = await fetch('/api/credential/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          role,
          slot,
          version,
          ...(expirySeconds ? { expirySeconds } : {}),
        }),
      });
      const data = await r.json();
      setMessage(data);
      if (data.credential) {
        const next = [
          ...tray,
          { ...data.credential, label: `${role === 'fanA' ? 'Fan A' : 'Fan B'} · v${version}`, role },
        ];
        setTray(next);
        localStorage.setItem('fairtickets-credentials', JSON.stringify(next));
      }
    } finally {
      setBusy(false);
    }
  }

  const activeAccount = status?.roles?.[role];
  const activeAddr = activeAccount?.address?.toLowerCase() || '';
  const isWinner = Boolean(activeAddr && status?.winners?.some((w) => w.toLowerCase() === activeAddr));
  const heldTicket = status?.tickets?.find((t) => t.owner.toLowerCase() === activeAddr);
  const activeListings = status?.tickets?.filter((t) => t.listed) || [];
  const phase = status?.phase?.toUpperCase() || '';

  return (
    <main className="page">
      <div className="zone-subnav" aria-label="User navigation">
        <Link href="/">Shows</Link>
        <Link href="/fan">Book Tickets</Link>
        <Link href="/bookings" className="active">
          My Bookings
        </Link>
      </div>

      <div className="card-head">
        <div>
          <p className="eyebrow">MY BOOKINGS &amp; PASSES</p>
          <h1>Manage Your Tickets</h1>
        </div>
        <button className="secondary" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {!isFan && (
        <p className="role-warning" role="status">
          Choose Fan A or Fan B in the top-right selector to view and manage your bookings.
        </p>
      )}
      {statusError && (
        <p className="role-warning" role="alert">
          {statusError}
        </p>
      )}

      <TxStatusBanner
        result={message}
        busy={busy}
        onResume={() => void act('tx/resume', { scanId: message?.scanId, txHash: message?.txHash })}
      />

      {isFan && status && (
        <section className="card">
          <div className="card-head">
            <h2>Your Ticket</h2>
            <span className="pill">{status.phase}</span>
          </div>

          {heldTicket ? (
            <div className="ticket-stub">
              <div className="ticket-stub-main">
                <span className="eyebrow">CONFIRMED BOOKING</span>
                <h3 style={{ margin: 0 }}>{eventMeta.title}</h3>
                <p className="meta" style={{ margin: 0 }}>
                  {eventMeta.venue} · {eventMeta.dateLabel}
                </p>
                <p style={{ margin: '6px 0 0' }}>
                  <strong>Seat #{heldTicket.slot}</strong> · Pass <code>v{heldTicket.version}</code> ·
                  Paid {formatWeiToInr(heldTicket.paidPriceWei, status.facePriceWei, status.facePriceInr)} ·{' '}
                  {heldTicket.admitted ? 'Checked in' : 'Ready for venue'}
                </p>
                {heldTicket.listed && (
                  <span className="pill warn">
                    Listed for resale at{' '}
                    {formatWeiToInr(heldTicket.resalePriceWei, status.facePriceWei, status.facePriceInr)}
                  </span>
                )}
              </div>
              <div className="ticket-stub-side">
                <button disabled={busy} onClick={() => void signPass(heldTicket.slot, heldTicket.version)}>
                  Generate Gate Pass
                </button>
                <Link className="small-link" href="/gate">
                  Show at Gate →
                </Link>
              </div>
            </div>
          ) : (
            <div>
              <p>
                {isWinner
                  ? 'You have a confirmed reservation waiting to be claimed.'
                  : status.drawn
                    ? 'No reservation was assigned to this account.'
                    : status.drawLocked
                      ? 'Allocation is pending finalization.'
                      : 'You do not hold a ticket yet.'}
              </p>
              <Link className="button small-btn" href="/fan">
                Go to Booking Page →
              </Link>
            </div>
          )}
        </section>
      )}

      {isFan && heldTicket && (
        <section className="card">
          <div className="card-head">
            <h2>Sell Your Ticket (Capped Resale)</h2>
            <span className="meta">
              Max allowed:{' '}
              {status ? formatWeiToInr(status.maxResalePriceWei, status.facePriceWei, status.facePriceInr) : '₹3,000'}
            </span>
          </div>
          <div className="inline-fields">
            <label>
              Resale price (INR)
              <input value={price} onChange={(e) => setPrice(e.target.value)} />
            </label>
            <div style={{ alignSelf: 'end' }}>
              <div className="preset-row" style={{ marginBottom: 0 }}>
                <button
                  type="button"
                  className="secondary small-btn"
                  onClick={() => setPrice(String(Math.round(((status?.facePriceInr || 3000) * 80) / 100)))}
                >
                  80%
                </button>
                <button
                  type="button"
                  className="secondary small-btn"
                  onClick={() => setPrice(String(status?.facePriceInr || 3000))}
                >
                  100% Cap
                </button>
                <button
                  disabled={busy || !phase.includes('RESALE')}
                  onClick={() =>
                    void act('list', {
                      slot: heldTicket.slot,
                      version: heldTicket.version,
                      priceWei: inrToWei(price, status?.facePriceWei, status?.facePriceInr),
                    })
                  }
                >
                  List for resale
                </button>
              </div>
            </div>
          </div>
          {!phase.includes('RESALE') && (
            <p className="meta">Resale listing opens during the RESALE stage.</p>
          )}
        </section>
      )}

      {isFan && !heldTicket && activeListings.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Available Resale Tickets</h2>
            <span className="pill ok">{activeListings.length} available</span>
          </div>
          {activeListings.map((t) => (
            <div key={t.slot} className="listing-row">
              <span>
                <strong>Seat #{t.slot}</strong> (Pass v{t.version}) ·{' '}
                {formatWeiToInr(t.resalePriceWei, status?.facePriceWei, status?.facePriceInr)}
              </span>
              <button
                disabled={busy}
                onClick={() =>
                  void act('buy', {
                    slot: t.slot,
                    version: t.version,
                    priceWei: t.resalePriceWei,
                  })
                }
              >
                Buy Ticket
              </button>
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Saved Entry Passes &amp; Wallet Credit</h2>
          {isFan && status && (
            <button disabled={busy} className="secondary small-btn" onClick={() => void act('withdraw')}>
              Withdraw Credit ({formatWeiToInr(activeAccount?.withdrawableWei, status.facePriceWei, status.facePriceInr)})
            </button>
          )}
        </div>
        {tray.length > 0 ? (
          <>
            <ul className="pass-list">
              {tray.map((c, i) => {
                const isOldEvent = Boolean(
                  status?.contract &&
                    c.contract &&
                    String(c.contract).toLowerCase() !== status.contract.toLowerCase(),
                );
                return (
                  <li key={i} className="pass-item">
                    <div>
                      <strong>{String(c.label)}</strong>
                      <span className="meta">
                        {' '}
                        · Seat #{String(c.slot)} · v{String(c.version)}
                      </span>
                      {isOldEvent && (
                        <span className="pill warn" style={{ marginLeft: 8 }}>
                          Old event
                        </span>
                      )}
                    </div>
                    <Link className="small-link" href="/gate">
                      Use at Gate →
                    </Link>
                  </li>
                );
              })}
            </ul>
            <div className="preset-row" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="secondary small-btn"
                onClick={() => {
                  setTray([]);
                  localStorage.removeItem('fairtickets-credentials');
                }}
              >
                Clear saved passes
              </button>
            </div>
          </>
        ) : (
          <p className="meta">No saved passes yet. Generate a pass once you hold a ticket.</p>
        )}
      </section>
    </main>
  );
}
