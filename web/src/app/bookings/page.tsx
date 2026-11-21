'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import QrPassCard from '@/components/QrPassCard';
import SecurityVerdictCard from '@/components/SecurityVerdictCard';
import TxStatusBanner from '@/components/TxStatusBanner';
import { DEFAULT_EVENT_META, loadEventMeta } from '@/lib/event-meta';
import { formatUnixTime, formatWeiToInr, inrToWei } from '@/lib/format';
import type { ApiMutationResponse, DemoStatusResponse, RoleId } from '@/lib/types';

export default function BookingsPage() {
  const [role, setRole] = useState<RoleId>('fanA');
  const [status, setStatus] = useState<DemoStatusResponse | null>(null);
  const [eventMeta, setEventMeta] = useState(DEFAULT_EVENT_META);
  const [price, setPrice] = useState('2400');
  const [tray, setTray] = useState<Array<Record<string, unknown>>>([]);
  const [activePass, setActivePass] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState<ApiMutationResponse | null>(null);
  const [statusError, setStatusError] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastGatedAction, setLastGatedAction] = useState<{ endpoint: string; body: Record<string, unknown> } | null>(null);

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
    const onRole = (e: Event) => {
      setRole((e as CustomEvent<RoleId>).detail);
      setMessage(null);
      setLastGatedAction(null);
      setActivePass(null);
    };
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
      const isSecurityGated = endpoint === 'buy';
      const securityPayload = isSecurityGated
        ? {
            subject: `demo-${role}-subject`,
            sessionId: `live_sess_${role}`,
            deviceId: `live_dev_${role}`,
            paymentTokenHash: `live_pay_${role}`,
            eventSaleId: status?.contract || 'fairtickets_live_sale',
          }
        : {};
      if (isSecurityGated) {
        setLastGatedAction({ endpoint, body });
      }
      const r = await fetch(`/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role, ...securityPayload, ...body }),
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
      const r = await fetch('/api/credential/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          role,
          slot,
          version,
        }),
      });
      const data = await r.json();
      setMessage(data);
      if (data.credential) {
        const entry = {
          ...data.credential,
          label: `${role === 'fanA' ? 'Fan A' : 'Fan B'} · v${version}`,
          role,
        };
        const filtered = tray.filter(
          (c) =>
            !(
              String(c.contract || '').toLowerCase() === String(entry.contract || '').toLowerCase() &&
              c.role === role &&
              Number(c.slot) === slot &&
              Number(c.version) === version
            ),
        );
        const next = [...filtered, entry];
        setTray(next);
        setActivePass(entry);
        localStorage.setItem('fairtickets-credentials', JSON.stringify(next));
      }
    } finally {
      setBusy(false);
    }
  }

  const activeAccount = status?.roles?.[role];
  const liveMeta = status?.eventMeta || eventMeta;
  const activeAddr = activeAccount?.address?.toLowerCase() || '';
  const isWinner = Boolean(activeAddr && status?.winners?.some((w) => w.toLowerCase() === activeAddr));
  const heldTicket = status?.tickets?.find((t) => t.owner.toLowerCase() === activeAddr);
  const activeListings = status?.tickets?.filter((t) => t.listed) || [];
  const phase = status?.phase?.toUpperCase() || '';
  const walletBalanceInr = status?.walletBalancesInr?.[role] ?? 0;
  const requiredPriceInr = status?.facePriceInr ?? 3000;
  const roleLabel = role === 'fanA' ? 'Fan A' : 'Fan B';
  const roleTray = tray.filter(
    (c) => c.role === role || (!c.role && String(c.label || '').startsWith(roleLabel)),
  );
  const matchingPass =
    activePass ||
    (heldTicket
      ? [...roleTray]
          .reverse()
          .find(
            (c) =>
              Number(c.slot) === heldTicket.slot &&
              Number(c.version) === heldTicket.version &&
              (!status?.contract ||
                !c.contract ||
                String(c.contract).toLowerCase() === status.contract.toLowerCase()),
          ) || null
      : null);
  const maxResaleWei = status?.maxResalePriceWei || status?.facePriceWei || '50000000000000000';
  const enteredPriceWei = status ? inrToWei(price, status.facePriceWei, status.facePriceInr) : '0';
  const priceExceedsCap = (() => {
    try {
      return BigInt(enteredPriceWei) > BigInt(maxResaleWei);
    } catch {
      return false;
    }
  })();
  const hasWithdrawable = (() => {
    try {
      return BigInt(activeAccount?.withdrawableWei || '0') > BigInt(0);
    } catch {
      return false;
    }
  })();

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
        <div className="actions" style={{ margin: 0 }}>
          {isFan && (
            <span className="pill ok">
              Wallet: ₹{walletBalanceInr.toLocaleString('en-IN')}
            </span>
          )}
          {isFan && (
            <button
              className="secondary small-btn"
              disabled={busy}
              onClick={() => void act('wallet/topup', { amountInr: requiredPriceInr })}
            >
              + Add ₹{requiredPriceInr.toLocaleString('en-IN')}
            </button>
          )}
          <button className="secondary small-btn" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
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

      <SecurityVerdictCard
        message={message}
        busy={busy}
        onSubmitChallenge={(challengeId, token, answer) => {
          if (!lastGatedAction) return;
          void act(lastGatedAction.endpoint, {
            ...lastGatedAction.body,
            challengeResponse: { challengeId, token, answer },
          });
        }}
      />

      {isFan && status && (
        <section className="card">
          <div className="card-head">
            <h2>Your Ticket</h2>
            <span className="pill">{status.phase}</span>
          </div>

          {heldTicket ? (
            <>
              <div className="ticket-stub">
                <div className="ticket-stub-main">
                  <span className="eyebrow">CONFIRMED BOOKING</span>
                  <h3 style={{ margin: 0 }}>{liveMeta.title}</h3>
                  <p className="meta" style={{ margin: 0 }}>
                    {liveMeta.venue} · {liveMeta.dateLabel}
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
                    {matchingPass ? 'Refresh QR Pass' : 'Get QR Pass'}
                  </button>
                </div>
              </div>
              {matchingPass && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                  <div className="card-head" style={{ marginBottom: 8 }}>
                    <span className="meta">
                      Active QR Pass · Valid until{' '}
                      <strong>{formatUnixTime(Number(matchingPass.expiry || 0))}</strong>
                    </span>
                    <Link className="small-link" href="/gate">
                      Verify at Gate Scanner →
                    </Link>
                  </div>
                  <QrPassCard credential={matchingPass} label={String(matchingPass.label || `${roleLabel} · v${heldTicket.version}`)} />
                </div>
              )}
            </>
          ) : (
            <div>
              <p>
                {phase.includes('CLAIM') && isWinner
                  ? 'You have a confirmed reservation waiting to be claimed.'
                  : phase.includes('RESALE')
                    ? 'You do not hold a ticket right now. Browse available resale listings below or return to Book Tickets.'
                    : phase.includes('GATE') || phase.includes('CLOSED')
                      ? 'You do not hold an active ticket for this event.'
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
              <button
                disabled={busy || !phase.includes('RESALE') || priceExceedsCap || Number(price) <= 0}
                onClick={() =>
                  void act('list', {
                    slot: heldTicket.slot,
                    version: heldTicket.version,
                    priceWei: enteredPriceWei,
                  })
                }
              >
                List for resale
              </button>
            </div>
          </div>
          {priceExceedsCap && (
            <p className="role-warning" role="alert" style={{ marginTop: 8 }}>
              Price exceeds the resale cap ({formatWeiToInr(maxResaleWei, status?.facePriceWei, status?.facePriceInr)}). Lower the price to list.
            </p>
          )}
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
          <h2>Saved Entry Passes &amp; Resale Payouts</h2>
          {isFan && status && (
            <div className="actions" style={{ margin: 0 }}>
              <button
                disabled={busy || !hasWithdrawable}
                className="secondary small-btn"
                onClick={() => void act('withdraw')}
              >
                Withdraw Credit ({formatWeiToInr(activeAccount?.withdrawableWei, status.facePriceWei, status.facePriceInr)})
              </button>
            </div>
          )}
        </div>
        {roleTray.length > 0 ? (
          <>
            <ul className="pass-list">
              {roleTray.map((c, i) => {
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
                        · Seat #{String(c.slot)} · v{String(c.version)} · Expires{' '}
                        {formatUnixTime(Number(c.expiry || 0))}
                      </span>
                      {isOldEvent && (
                        <span className="pill warn" style={{ marginLeft: 8 }}>
                          Old event
                        </span>
                      )}
                    </div>
                    <div className="actions" style={{ margin: 0 }}>
                      <button
                        type="button"
                        className="secondary small-btn"
                        onClick={() => setActivePass(c)}
                      >
                        View QR
                      </button>
                      <Link className="small-link" href="/gate">
                        Gate Scanner →
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="preset-row" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="secondary small-btn"
                onClick={() => {
                  const remaining = tray.filter(
                    (c) => !(c.role === role || (!c.role && String(c.label || '').startsWith(roleLabel))),
                  );
                  setTray(remaining);
                  setActivePass(null);
                  localStorage.setItem('fairtickets-credentials', JSON.stringify(remaining));
                }}
              >
                Clear {roleLabel} passes
              </button>
            </div>
          </>
        ) : (
          <p className="meta">No saved passes for {roleLabel} yet. Click &ldquo;Get QR Pass&rdquo; once you hold a ticket.</p>
        )}
      </section>
    </main>
  );
}
