'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import StadiumSeating from '@/components/StadiumSeating';
import TxStatusBanner from '@/components/TxStatusBanner';
import { DEFAULT_EVENT_META, loadEventMeta } from '@/lib/event-meta';
import { formatWeiToInr, inrToWei } from '@/lib/format';
import type { ApiMutationResponse, DemoStatusResponse, RoleId } from '@/lib/types';

export default function FanPage() {
  const [role, setRole] = useState<RoleId>('fanA');
  const [status, setStatus] = useState<DemoStatusResponse | null>(null);
  const [subject, setSubject] = useState('fan-a-subject');
  const [slot, setSlot] = useState('1');
  const [selectedSeat, setSelectedSeat] = useState(1);
  const [version, setVersion] = useState('1');
  const [price, setPrice] = useState('2400');
  const [message, setMessage] = useState<ApiMutationResponse | null>(null);
  const [tray, setTray] = useState<Array<Record<string, unknown>>>([]);
  const [enteredByContract, setEnteredByContract] = useState<Record<string, Record<string, { blockNumber?: number | null }>>>({});
  const [eventMeta, setEventMeta] = useState(DEFAULT_EVENT_META);
  const [statusError, setStatusError] = useState('');
  const [busy, setBusy] = useState(false);
  const [challengeAnswer, setChallengeAnswer] = useState('');
  const [lastGatedAction, setLastGatedAction] = useState<{ endpoint: string; body: Record<string, unknown> } | null>(null);
  const isFan = role === 'fanA' || role === 'fanB';

  async function refresh(): Promise<DemoStatusResponse | null> {
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      const data = await r.json();
      if (!r.ok || data.ok === false) throw new Error(data.error || 'Could not load chain state.');
      setStatus(data);
      setStatusError('');
      return data as DemoStatusResponse;
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'Could not load chain state.');
      return null;
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
    try {
      const savedEntered = localStorage.getItem('fairtickets-entered');
      if (savedEntered) setEnteredByContract(JSON.parse(savedEntered));
    } catch {
      localStorage.removeItem('fairtickets-entered');
    }
    const onRole = (e: Event) => {
      const next = (e as CustomEvent<RoleId>).detail;
      setRole(next);
      if (next === 'fanA' || next === 'fanB') setSubject(`demo-${next}-subject`);
    };
    window.addEventListener('fairtickets-role-change', onRole);
    const active = localStorage.getItem('fairtickets-role') as RoleId | null;
    if (active) {
      setRole(active);
      if (active === 'fanA' || active === 'fanB') setSubject(`demo-${active}-subject`);
    }
    return () => {
      clearInterval(id);
      window.removeEventListener('fairtickets-role-change', onRole);
    };
  }, []);

  async function act(endpoint: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      const isSecurityGated = endpoint === 'enter' || endpoint === 'claim' || endpoint === 'buy';
      const securityPayload = isSecurityGated
        ? {
            subject: strSubject(body.subject),
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
      const data = (await r.json()) as ApiMutationResponse;
      setMessage(data);
      const latestStatus = await refresh();
      const contractAddr = latestStatus?.contract || status?.contract;
      if (endpoint === 'enter' && data.txStatus === 'confirmed' && contractAddr) {
        const contractKey = contractAddr.toLowerCase();
        setEnteredByContract((prev) => {
          const next = {
            ...prev,
            [contractKey]: {
              ...(prev[contractKey] || {}),
              [role]: { blockNumber: data.blockNumber ?? null },
            },
          };
          try {
            localStorage.setItem('fairtickets-entered', JSON.stringify(next));
          } catch {}
          return next;
        });
      }
    } finally {
      setBusy(false);
    }
  }

  function strSubject(override: unknown) {
    return typeof override === 'string' && override.trim() ? override.trim() : subject.trim() || `demo-${role}-subject`;
  }

  async function credential() {
    setBusy(true);
    try {
      const inGate = status?.phase?.toUpperCase().includes('GATE');
      const expirySeconds = !inGate && status?.resaleCutoff ? status.resaleCutoff + 60 : undefined;
      const r = await fetch('/api/credential/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          role,
          slot: Number(slot),
          version: Number(version),
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

  function applyPriceRatio(numerator: number, denominator: number) {
    const baseInr = status?.facePriceInr || 3000;
    const val = Math.round((baseInr * numerator) / denominator);
    setPrice(String(val));
  }

  const activeAccount = status?.roles?.[role];
  const liveMeta = status?.eventMeta || eventMeta;
  const activeAddr = activeAccount?.address?.toLowerCase() || '';
  const isWinner = Boolean(activeAddr && status?.winners?.some((w) => w.toLowerCase() === activeAddr));
  const heldTicket = status?.tickets?.find((t) => t.owner.toLowerCase() === activeAddr);
  const activeListings = status?.tickets?.filter((t) => t.listed) || [];
  const phase = status?.phase?.toUpperCase() || '';
  const enteredInfo = status?.contract ? enteredByContract[status.contract.toLowerCase()]?.[role] : undefined;
  const walletBalanceInr = status?.walletBalancesInr?.[role] ?? 0;
  const requiredPriceInr = status?.facePriceInr ?? 3000;
  const hasEnoughBalance = walletBalanceInr >= requiredPriceInr;

  useEffect(() => {
    if (heldTicket) {
      setSlot(String(heldTicket.slot));
      setVersion(String(heldTicket.version));
    } else if (activeListings.length > 0) {
      setSlot(String(activeListings[0].slot));
      setVersion(String(activeListings[0].version));
    }
  }, [role, heldTicket?.slot, heldTicket?.version, activeListings[0]?.slot, activeListings[0]?.version]);

  const fanQueueStatus = !status
    ? 'Loading bookings…'
    : heldTicket
      ? `Confirmed booking · Seat #${heldTicket.slot} (Pass v${heldTicket.version}${heldTicket.admitted ? ', checked in' : ''})`
      : isWinner
        ? 'Reservation available to claim'
        : status.drawn
          ? 'No reservation after finalization'
          : status.drawLocked
            ? 'Allocation pending'
            : enteredInfo
              ? 'Entry confirmed'
              : 'Not yet entered';

  const friendlyStage = !status
    ? 'Connecting'
    : phase.includes('ENTRY')
      ? 'Queue Open'
      : phase.includes('DRAW')
        ? 'Finalizing Reservations'
        : phase.includes('CLAIM')
          ? 'Claim Open'
          : phase.includes('RESALE')
            ? 'Resale Open'
            : phase.includes('GATE')
              ? 'Doors Open'
              : 'Event Ended';

  return (
    <main className="page">
      <div className="zone-subnav" aria-label="User navigation">
        <Link href="/">Shows</Link>
        <Link href="/fan" className="active">
          Book Tickets
        </Link>
        <Link href="/bookings">My Bookings</Link>
      </div>

      <div className="card-head">
        <div>
          <p className="eyebrow">BOOK TICKETS · {liveMeta.venue.toUpperCase()}</p>
          <h1>{liveMeta.title}</h1>
        </div>
        <Link className="button secondary small-btn" href="/bookings">
          Manage Bookings →
        </Link>
      </div>

      <section className="status-strip" aria-label="Your ticket status">
        <div>
          <span>Active fan</span>
          <strong>{isFan ? (role === 'fanA' ? 'Fan A' : 'Fan B') : role[0].toUpperCase() + role.slice(1)}</strong>
        </div>
        <div>
          <span>Event phase</span>
          <strong>{status ? `${status.phase} (${friendlyStage})` : 'Connecting…'}</strong>
        </div>
        <div>
          <span>Your booking status</span>
          <strong>{isFan ? fanQueueStatus : 'Select Fan A or Fan B'}</strong>
        </div>
        <div>
          <span>Wallet balance</span>
          <strong>
            ₹{walletBalanceInr.toLocaleString('en-IN')}
          </strong>
        </div>
        <div style={{ alignSelf: 'center', justifySelf: 'end', display: 'flex', gap: 8 }}>
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
      </section>

      {!isFan && (
        <p className="role-warning" role="status">
          Choose Fan A or Fan B in the role selector to use fan actions.
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

      {message?.securityDecision && (
        <section className="card" aria-live="polite">
          <div className="card-head">
            <h2>Live Security &amp; ML Verdict</h2>
            <span
              className={`pill ${
                message.securityDecision.decision === 'ALLOW'
                  ? 'ok'
                  : message.securityDecision.decision === 'BLOCK'
                    ? 'danger'
                    : 'warn'
              }`}
            >
              {message.securityDecision.decision || 'ALLOW'} · Risk {message.securityDecision.riskScore ?? 0}/100
            </span>
          </div>
          <div className="metrics-grid">
            <div className="metric">
              <span>Supervised ML Score</span>
              <strong>{message.securityDecision.mlScore ?? 0} / 100</strong>
              <small>Decision ID: {message.securityDecision.decisionId || '—'}</small>
            </div>
            <div className="metric">
              <span>Unsupervised Anomaly</span>
              <strong>{message.securityDecision.unsupervisedAnomalyScore ?? 0} / 100</strong>
              <small>Live Welford Human Baseline</small>
            </div>
            <div className="metric">
              <span>Reasons</span>
              <strong>
                {message.securityDecision.reasons && message.securityDecision.reasons.length > 0
                  ? message.securityDecision.reasons.join(', ')
                  : 'Clean ALLOW'}
              </strong>
              <small>Enforced server-side before Anvil tx</small>
            </div>
          </div>
          {message.stepUpChallenge && lastGatedAction && (
            <div style={{ marginTop: 12 }}>
              <p>
                <strong>{message.stepUpChallenge.prompt}</strong>
              </p>
              <div className="inline-fields" style={{ marginTop: 8 }}>
                <label>
                  Verification Answer
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="Enter answer"
                    value={challengeAnswer}
                    disabled={busy}
                    onChange={(e) => setChallengeAnswer(e.target.value)}
                  />
                </label>
              </div>
              <div className="actions" style={{ marginTop: 10 }}>
                <button
                  disabled={busy || !challengeAnswer.trim()}
                  onClick={() => {
                    const chl = message.stepUpChallenge;
                    if (!chl) return;
                    const answer = challengeAnswer.trim();
                    setChallengeAnswer('');
                    void act(lastGatedAction.endpoint, {
                      ...lastGatedAction.body,
                      challengeResponse: {
                        challengeId: chl.challengeId,
                        token: chl.token,
                        answer,
                      },
                    });
                  }}
                >
                  {busy ? 'Verifying…' : 'Submit Verification & Retry'}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {(!status || phase.includes('ENTRY')) && (
        <section className="card narrow card-active">
          <div className="card-head">
            <h2>Join Queue</h2>
            <span className="pill ok">Seat #S{selectedSeat}</span>
          </div>
          {status && (
            <StadiumSeating
              capacity={status.capacity}
              tickets={status.tickets}
              selectedSeat={selectedSeat}
              onSelectSeat={(num) => {
                setSelectedSeat(num);
                setSlot(String(num));
              }}
            />
          )}
          {isFan && status && (
            <p className="meta">
              Status: <strong>{fanQueueStatus}</strong>
            </p>
          )}
          {isFan && status && !hasEnoughBalance && (
            <div className="role-warning" style={{ margin: '10px 0' }}>
              Wallet balance ₹{walletBalanceInr.toLocaleString('en-IN')} is below ₹{requiredPriceInr.toLocaleString('en-IN')}.{' '}
              <button
                type="button"
                className="small-btn"
                style={{ marginLeft: 8 }}
                disabled={busy}
                onClick={() => void act('wallet/topup', { amountInr: requiredPriceInr })}
              >
                Add ₹{requiredPriceInr.toLocaleString('en-IN')}
              </button>
            </div>
          )}
          <button disabled={!isFan || busy || (Boolean(status) && !hasEnoughBalance)} onClick={() => void act('enter', { subject })}>
            Enter event
          </button>
        </section>
      )}

      {status && phase.includes('DRAW') && (
        <section className="card narrow">
          <div className="card-head">
            <h2>Finalizing Reservations</h2>
            <span className="pill">Queue Closed</span>
          </div>
          <p className="meta">
            The queue is closed. Reservations are being finalized by the organiser.
          </p>
        </section>
      )}

      {status && phase.includes('CLAIM') && (
        <section className="card narrow card-active">
          <div className="card-head">
            <h2>Claim if Selected</h2>
            <span className="pill ok">
              {formatWeiToInr(status.facePriceWei, status.facePriceWei, status.facePriceInr)}
            </span>
          </div>
          <StadiumSeating
            capacity={status.capacity}
            tickets={status.tickets}
            selectedSeat={heldTicket ? heldTicket.slot : selectedSeat}
            onSelectSeat={(num) => {
              setSelectedSeat(num);
              setSlot(String(num));
            }}
          />
          {isFan && (
            <p className="meta">
              {heldTicket
                ? `Booked Seat #${heldTicket.slot} (v${heldTicket.version})`
                : isWinner
                  ? 'You were selected! Claim your ticket below.'
                  : 'No reservation for this account.'}
            </p>
          )}
          <div className="actions" style={{ marginBottom: 0 }}>
            {isFan && isWinner && !heldTicket && (
              <button disabled={busy} onClick={() => void act('claim')}>
                Claim reserved ticket
              </button>
            )}
            {heldTicket && (
              <Link className="button secondary" href="/bookings">
                Go to My Bookings (QR) →
              </Link>
            )}
          </div>
        </section>
      )}

      {status && phase.includes('RESALE') && (
        <section className="card narrow card-active">
          <div className="card-head">
            <h2>Capped Resale</h2>
            <span className="pill ok">
              Max {formatWeiToInr(status.maxResalePriceWei, status.facePriceWei, status.facePriceInr)}
            </span>
          </div>

          {activeListings.length > 0 && (
            <div className="listing-box">
              <strong>Available listing:</strong>
              {activeListings.map((t) => (
                <div key={t.slot} className="listing-row">
                  <span>
                    Seat #{t.slot} (v{t.version}) ·{' '}
                    {formatWeiToInr(t.resalePriceWei, status.facePriceWei, status.facePriceInr)}
                  </span>
                  <button
                    type="button"
                    className="secondary small-btn"
                    onClick={() => {
                      setSlot(String(t.slot));
                      setVersion(String(t.version));
                      const inrLabel = formatWeiToInr(t.resalePriceWei, status.facePriceWei, status.facePriceInr).replace(/[₹,\s]/g, '');
                      setPrice(inrLabel || '2400');
                    }}
                  >
                    Fill listing
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="inline-fields">
            <label>
              Slot
              <input value={slot} onChange={(e) => setSlot(e.target.value)} />
            </label>
            <label>
              Ticket version
              <input value={version} onChange={(e) => setVersion(e.target.value)} />
            </label>
          </div>

          <label>
            Resale price (INR)
            <input value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>

          <div className="actions" style={{ marginBottom: 0 }}>
            <button
              disabled={!isFan || busy}
              className={heldTicket && !heldTicket.listed ? '' : 'secondary'}
              onClick={() =>
                void act('list', {
                  slot: Number(slot),
                  version: Number(version),
                  priceWei: inrToWei(price, status.facePriceWei, status.facePriceInr),
                })
              }
            >
              List for resale
            </button>
            <button
              disabled={!isFan || busy}
              className={!heldTicket && activeListings.length > 0 ? '' : 'secondary'}
              onClick={() =>
                void act('buy', {
                  slot: Number(slot),
                  version: Number(version),
                  priceWei: inrToWei(price, status.facePriceWei, status.facePriceInr),
                })
              }
            >
              Buy listing
            </button>
          </div>
        </section>
      )}

      {status && (phase.includes('GATE') || phase.includes('CLOSED')) && (
        <section className="card narrow card-active">
          <div className="card-head">
            <h2>Get QR Pass</h2>
            <span className="pill ok">Doors Open</span>
          </div>
          <div className="actions">
            <button disabled={!isFan || busy} onClick={() => void credential()}>
              Sign and save credential
            </button>
            <Link className="button secondary" href="/bookings">
              Open My Bookings →
            </Link>
            <button disabled={!isFan || busy} className="secondary" onClick={() => void act('withdraw')}>
              Withdraw proceeds
            </button>
          </div>
          {tray.length > 0 && (
            <ul className="pass-list">
              {tray.map((c, i) => (
                <li key={i} className="pass-item">
                  <span>
                    <strong>{String(c.label)}</strong> · Seat #{String(c.slot)} · v{String(c.version)}
                  </span>
                  <Link className="small-link" href="/gate">
                    Show at Gate →
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
