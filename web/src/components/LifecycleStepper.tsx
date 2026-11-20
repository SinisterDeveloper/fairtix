'use client';

type ContextPage = 'fan' | 'gate' | 'organiser';

const STEPS = [
  { key: 'ENTRY', label: '1. Enter Draw', sub: 'Fans register once' },
  { key: 'DRAW', label: '2. Fair Draw', sub: 'Organiser picks winners' },
  { key: 'CLAIM', label: '3. Claim Ticket', sub: 'Buy at face price' },
  { key: 'RESALE', label: '4. Capped Resale', sub: 'Optional <= cap trade' },
  { key: 'GATE', label: '5. Venue Gate', sub: 'One-time check-in' },
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
    if (context === 'fan') return 'Entry is open. Switch between Fan A and Fan B in the top bar and click "Enter event" for each fan.';
    if (context === 'organiser') return 'Entry is open. Once fans have registered, click "Close entry and lock draw" below.';
    return 'Entry is still open. Fans must register, draw, claim, and reach the Gate phase before scanning.';
  }
  if (idx === 1) {
    if (context === 'organiser') return 'Draw is ready. Click "Close entry and lock draw" (if not locked), then click "Run draw" to select winners.';
    return 'Entry is closed and the draw is running. Go to the Organiser tab to run the draw.';
  }
  if (idx === 2) {
    if (context === 'fan') return 'Winners are selected! Switch to the winning fan role and click "Claim reserved ticket" to buy at face price.';
    if (context === 'organiser') return 'Claim window is open. Winning fans can now claim their reserved tickets on the Fan tab.';
    return 'Claim window is open. Winning fans must claim their ticket before the Gate opens.';
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
              <span className="step-title">{step.label}</span>
              <span className="step-sub">{step.sub}</span>
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
