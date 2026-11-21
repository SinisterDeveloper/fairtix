'use client';

import { useState, type FormEvent } from 'react';
import { capacityInputs, type CapacityReport } from '@/lib/security-capacity';

const wholeNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const buyerPresets = [1_000, 10_000, 100_000];

function CapacityResults({ report }: { report: CapacityReport }) {
  const metrics = [
    ['Events evaluated', wholeNumber.format(report.events)],
    ['Tickets sold', wholeNumber.format(report.sold)],
    ['Reservations converted', wholeNumber.format(report.convertedHolds)],
    ['Peak active holds', wholeNumber.format(report.peakHeld)],
    ['Active holds at close', wholeNumber.format(report.finalHeld)],
    ['Tickets available at close', wholeNumber.format(report.available)],
    ['Challenged decisions', wholeNumber.format(report.challenged)],
    ['Blocked decisions', wholeNumber.format(report.blocked)],
    ['Unauthorized checkouts', wholeNumber.format(report.unauthorizedCheckouts)],
    ['Throughput', `${wholeNumber.format(report.eventsPerSecond)} events/s`],
    ['p95 event evaluation', `${decimal.format(report.evaluationLatencyMs.p95)} ms`],
    ['p99 event evaluation', `${decimal.format(report.evaluationLatencyMs.p99)} ms`],
    ['Sampled peak process memory', `${decimal.format(report.sampledPeakRssBytes / 1_048_576)} MiB`],
    ['Total evaluation time', `${decimal.format(report.elapsedMs / 1_000)} s`],
  ];

  return (
    <section className="card" aria-labelledby="capacity-results-title">
      <div className="card-head">
        <h2 id="capacity-results-title">Security engine capacity results</h2>
        <span className={`pill ${report.ok ? 'ok' : 'danger'}`}>
          {report.ok ? 'Run checks passed' : 'Run checks failed'}
        </span>
      </div>
      <p>
        {wholeNumber.format(report.buyers)} synthetic buyers · {wholeNumber.format(report.waveSize)} buyers per wave ·{' '}
        {wholeNumber.format(report.buyersPerNetwork)} buyers per shared network
      </p>
      <dl className="metrics-grid capacity-metrics">
        {metrics.map(([label, value]) => (
          <div className="metric" key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default function SecurityCapacity({ getOperatorToken }: { getOperatorToken: () => string }) {
  const [buyers, setBuyers] = useState(String(capacityInputs.buyers.defaultValue));
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<CapacityReport | null>(null);
  const [error, setError] = useState('');

  async function runBenchmark(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    const operatorToken = getOperatorToken();
    setReport(null);
    setError('');
    if (!operatorToken) {
      setError('Enter the operator token to run the capacity benchmark.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/security/capacity', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${operatorToken}`,
        },
        body: JSON.stringify({
          buyers: Number(fields.get('buyers')),
          waveSize: Number(fields.get('waveSize')),
          buyersPerNetwork: Number(fields.get('buyersPerNetwork')),
        }),
      });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error || 'Capacity benchmark failed.');
      }
      setReport(await response.json() as CapacityReport);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Capacity benchmark failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card" aria-labelledby="capacity-title">
        <h2 id="capacity-title">Security engine capacity benchmark</h2>
        <p>Measure a single in-memory sale with synthetic legitimate buyers moving through queue entry, reservation, and checkout.</p>
        <form method="post" onSubmit={runBenchmark} aria-busy={busy}>
          <div className="actions capacity-presets" role="group" aria-label="Buyer presets">
            {buyerPresets.map((count) => (
              <button
                key={count}
                className="secondary"
                type="button"
                disabled={busy}
                aria-pressed={Number(buyers) === count}
                onClick={() => setBuyers(String(count))}
              >
                {wholeNumber.format(count)} buyers
              </button>
            ))}
          </div>
          <fieldset className="inline-fields security-evaluation-fields" disabled={busy} aria-label="Capacity benchmark configuration">
            <label>
              {capacityInputs.buyers.label}
              <input
                type="number"
                name="buyers"
                min={capacityInputs.buyers.min}
                max={capacityInputs.buyers.max}
                value={buyers}
                onChange={(event) => setBuyers(event.target.value)}
                required
              />
            </label>
            {(['waveSize', 'buyersPerNetwork'] as const).map((field) => {
              const { label, min, max, defaultValue } = capacityInputs[field];
              return (
                <label key={field}>
                  {label}
                  <input type="number" name={field} min={min} max={max} defaultValue={defaultValue} required />
                </label>
              );
            })}
          </fieldset>
          <button type="submit" disabled={busy}>
            {busy ? 'Running capacity benchmark…' : 'Run capacity benchmark'}
          </button>
        </form>
        <p role="status">{busy ? 'Evaluating the synthetic sale…' : report ? 'Capacity benchmark complete.' : ''}</p>
        {error && <p className="role-warning" role="alert">{error}</p>}
      </section>
      {report && <CapacityResults report={report} />}
    </>
  );
}
