'use client';

import Link from 'next/link';

type ContextPage = 'fan' | 'gate' | 'organiser';

const STEPS = [
  { key: 'EVENT', label: '1. Click on Event', sub: 'Select a live show', href: '/' },
  { key: 'ENTRY', label: '2. Join Queue', sub: 'Enter booking queue', href: '/fan' },
  { key: 'CLAIM', label: '3. Claim if Selected', sub: 'Confirm your ticket', href: '/fan' },
  { key: 'BOOKINGS', label: '4. My Bookings & QR', sub: 'Get QR for gate', href: '/bookings' },
  { key: 'GATE', label: '5. Show QR at Gate', sub: 'One-time check-in', href: '/gate' },
] as const;

function stepIndex(phase?: string): number {
  if (!phase) return -1;
  const p = phase.toUpperCase();
  if (p.includes('ENTRY')) return 1;
  if (p.includes('DRAW')) return 2;
  if (p.includes('CLAIM')) return 2;
  if (p.includes('RESALE')) return 3;
  if (p.includes('GATE')) return 4;
  if (p.includes('CLOSED')) return 5;
  return 1;
}

function nextActionHint(phase: string | undefined, context: ContextPage): string {
  const p = (phase || '').toUpperCase();
  if (!p) return 'Connecting to event service…';
  if (p.includes('ENTRY')) {
    if (context === 'fan') return 'Step 2: Join Queue — click "Enter event" for each fan.';
    if (context === 'organiser') return 'Queue is open. Once fans join, click "Close entry and lock allocation" below.';
    return 'Queue is open. Fans must join the queue, claim if selected, and get their QR in My Bookings.';
  }
  if (p.includes('DRAW')) {
    if (context === 'organiser') return 'Queue closed. Click "Close entry and lock allocation" (if not locked), then "Finalize reservations".';
    return 'Queue closed — waiting for organiser to finalize reservations.';
  }
  if (p.includes('CLAIM')) {
    if (context === 'fan') return 'Step 3: Claim if Selected — click "Claim reserved ticket", then go to My Bookings to get your QR.';
    if (context === 'organiser') return 'Claim window is open. Selected fans can claim their ticket on Book Tickets.';
    return 'Claim window is open. Selected fans must claim and get their QR in My Bookings before Gate opens.';
  }
  if (p.includes('RESALE')) {
    if (context === 'fan') return 'Step 4: Go to My Bookings to get your QR pass (or list/buy on capped resale).';
    if (context === 'organiser') return 'Resale window is open. Advance to Gate when ready for venue check-in.';
    return 'Resale window is open. Fans can get their QR pass in My Bookings before Gate opens.';
  }
  if (p.includes('GATE')) {
    if (context === 'gate') return 'Step 5: Show QR at Gate — select a saved pass or paste pass details, then click "Verify and redeem".';
    if (context === 'fan') return 'Step 5: Doors are open! Go to My Bookings to get your QR pass and show it at the Gate.';
    return 'Doors are open. Gate staff are scanning QR passes.';
  }
  return 'This event has ended.';
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
