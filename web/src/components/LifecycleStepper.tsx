'use client';

import Link from 'next/link';

type ContextPage = 'fan' | 'gate' | 'organiser';

const STEPS = [
  { key: 'ENTRY', label: '1. Join Queue', sub: 'Fans enter once', href: '/fan' },
  { key: 'DRAW', label: '2. Finalize', sub: 'Queue / batch lottery', href: '/organiser' },
  { key: 'CLAIM', label: '3. Claim Ticket', sub: 'Buy at face price', href: '/fan' },
  { key: 'RESALE', label: '4. Capped Resale', sub: 'Optional <= cap trade', href: '/fan' },
  { key: 'GATE', label: '5. Venue Gate', sub: 'One-time check-in', href: '/gate' },
] as const;

function stepIndex(phase?: string): number {
  if (!phase) return -1;
  const p = phase.toUpperCase();
  if (p.includes('ENTRY')) return 0;
  if (p.includes('DRAW')) return 1;
  if (p.includes('CLAIM')) return 2;
  if (p.includes('RESALE')) return 3;
  if (p.includes('GATE')) return 4;
  if (p.includes('CLOSED')) return 5;
  return 0;
}

function nextActionHint(phase: string | undefined, context: ContextPage): string {
  const idx = stepIndex(phase);
  if (idx === -1) return 'Connecting to local Anvil chain…';
  if (idx === 0) {
    if (context === 'fan') return 'Entry is open. Switch between Fan A and Fan B in the top bar and click "Enter event" to join the ticket queue.';
    if (context === 'organiser') return 'Entry is open. Once fans have joined the queue, click "Close entry and lock allocation" below.';
    return 'Entry is still open. Fans must join the queue, finalize reservations, claim, and reach the Gate phase before scanning.';
  }
  if (idx === 1) {
    if (context === 'organiser') return 'Allocation is ready. Click "Close entry and lock allocation" (if not locked), then click "Finalize reservations".';
    return 'Entry is closed and allocation is pending. Go to the Organiser tab to finalize reservations.';
  }
  if (idx === 2) {
    if (context === 'fan') return 'Reservations are finalized! Switch to a reserved fan role and click "Claim reserved ticket" to buy at face price.';
    if (context === 'organiser') return 'Claim window is open. Reserved fans can now claim their tickets on the Fan tab.';
    return 'Claim window is open. Reserved fans must claim their ticket before the Gate opens.';
  }
  if (idx === 3) {
    if (context === 'fan') return 'Resale window is open. The ticket holder can list at or below the cap, and the other fan can buy it.';
    if (context === 'organiser') return 'Resale window is open. Any transfers are price-capped on-chain.';
    return 'Resale window is open. Fans can sign passes now, and the Gate will accept them once the Gate window opens.';
  }
  if (idx === 4) {
    if (context === 'gate') return 'Venue Gate is open! Select a saved pass or paste Credential JSON, then click "Verify and redeem".';
    if (context === 'fan') return 'Venue Gate is open! Sign a gate pass for your ticket and take it to the Gate tab to enter.';
    return 'Venue Gate is open. Gate staff are verifying passes and marking tickets admitted on-chain.';
  }
  return 'This event has closed. Organiser and sellers can still withdraw any remaining proceeds.';
}

export default function LifecycleStepper({
  phase,
  context,
}: {
  phase?: string;
  context: ContextPage;
}) {
  const activeIdx = stepIndex(phase);

  return (
    <section className="stepper-wrap" aria-label="Event lifecycle progress">
      <ol className="stepper">
        {STEPS.map((step, i) => {
          const state =
            activeIdx < 0
              ? 'upcoming'
              : i < activeIdx
                ? 'done'
                : i === activeIdx
                  ? 'active'
                  : 'upcoming';
          return (
            <li key={step.key} className={`step ${state}`}>
              <Link href={step.href} className="step-link">
                <span className="step-title">{step.label}</span>
                <span className="step-sub">{step.sub}</span>
              </Link>
            </li>
          );
        })}
      </ol>
      <p className="stepper-hint">
        <strong>Next step:</strong> {nextActionHint(phase, context)}
      </p>
    </section>
  );
}
