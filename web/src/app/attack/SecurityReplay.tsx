'use client';

import { useState, type FormEvent } from 'react';
import {
  replayDefaults,
  replayFixtures,
  replayProfiles,
  replayRanges,
  type ReplayEvidence,
  type ReplayRate,
  type ReplayResponse,
  type ReplayRun,
} from '@/lib/security-replay';

const percentage = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 });

function formatRate(rate: ReplayRate) {
  if (rate.denominator === 0) return 'N/A';
  return `${percentage.format(rate.numerator / rate.denominator)} (${rate.numerator}/${rate.denominator})`;
}

function RiskScores({ entry }: { entry: ReplayEvidence }) {
  const scores = [
    ['Overall risk', entry.riskScore],
    ['Supervised ML', entry.mlScore],
    ['Baseline anomaly', entry.unsupervisedAnomalyScore],
  ] as const;
  const contributors = entry.mlTopContributors ?? [];

  return (
    <>
      <dl className="replay-risk-scores">
        {scores.map(([label, score]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{score == null ? 'N/A' : `${score}/100`}</dd>
          </div>
        ))}
      </dl>
      {contributors.length > 0 && (
        <details className="replay-model-features">
          <summary>Features raising the ML score</summary>
          <ul>
            {contributors.map(({ feature, value, contribution }) => (
              <li key={feature}>
                <code>{feature}</code> {value} ({contribution > 0 ? '+' : ''}{contribution} model weight contribution)
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function Evidence({ mode, run }: { mode: string; run: ReplayRun }) {
  return (
    <details className="replay-evidence">
      <summary>{mode} audit evidence ({run.evidence.length} decisions)</summary>
      <div className="table-wrap" role="region" aria-label={`${mode} event decisions`} tabIndex={0}>
        <table aria-label={`${mode} audit evidence`}>
          <thead>
            <tr>
              <th scope="col">Decision ID / Event</th>
              <th scope="col">Fixture identity</th>
              <th scope="col">Behavioral decision</th>
              <th scope="col">Applied decision</th>
              <th scope="col">Risk scores</th>
              <th scope="col">Reasons</th>
              <th scope="col">Tickets sold</th>
              <th scope="col">Available</th>
            </tr>
          </thead>
          <tbody>
            {run.evidence.map((entry) => (
              <tr key={entry.decisionId}>
                <td>
                  <code>{entry.decisionId} / {entry.eventId}</code>
                  <div className="meta">{entry.eventType}</div>
                </td>
                <td>
                  <code>{entry.accountId}</code>
                  <div className="meta">{entry.malicious ? 'Malicious' : 'Legitimate'}</div>
                </td>
                <td>{entry.behavioralDecision}</td>
                <td>
                  <span className={`pill ${entry.decision === 'ALLOW' ? 'ok' : 'warn'}`}>
                    {entry.decision}
                  </span>
                  {entry.hardFailure && <div className="meta">Hard policy denial</div>}
                </td>
                <td><RiskScores entry={entry} /></td>
                <td>
                  {entry.reasons.length ? entry.reasons.map((reason) => (
                    <div key={reason}><code>{reason}</code></div>
                  )) : '—'}
                </td>
                <td>{entry.ticketsCommitted}</td>
                <td>{entry.available}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function ReplayReport({ report }: { report: ReplayResponse }) {
  const { config, observe, enforce } = report;
  const comparisons = [
    ['Malicious tickets sold', observe.maliciousTicketsSold, enforce.maliciousTicketsSold],
    ['Legitimate tickets sold', observe.legitimateTicketsSold, enforce.legitimateTicketsSold],
    ['Legitimate purchase completion', formatRate(observe.legitimateCompletion), formatRate(enforce.legitimateCompletion)],
    ['Detection recall', formatRate(observe.detectionRecall), formatRate(enforce.detectionRecall)],
    ['False-positive rate', formatRate(observe.falsePositiveRate), formatRate(enforce.falsePositiveRate)],
    ['Unauthorized checkouts', observe.unauthorizedCheckouts, enforce.unauthorizedCheckouts],
    ['Hard policy denials', observe.hardDenials, enforce.hardDenials],
    ['Tickets sold / held / available at close', `${observe.sold} / ${observe.held} / ${observe.available}`, `${enforce.sold} / ${enforce.held} / ${enforce.available}`],
    ['Lowest available inventory', observe.minimumAvailable, enforce.minimumAvailable],
    ['Holds released', observe.releasedHolds, enforce.releasedHolds],
  ] as const;

  return (
    <section className="card" aria-labelledby="replay-results-title">
      <h2 id="replay-results-title">Security-service checkouts</h2>
      <p className="meta">
        {replayFixtures[config.fixture]} · Seed {config.seed} · {config.participants} participants ·{' '}
        {config.inventory} starting tickets · {report.eventCount} events per mode · {replayProfiles[config.profile]}
      </p>
      <div className="table-wrap">
        <table className="replay-comparison" aria-label="Replay comparison">
          <thead>
            <tr>
              <th scope="col">Measure</th>
              <th scope="col">Observe</th>
              <th scope="col">Enforce</th>
            </tr>
          </thead>
          <tbody>
            {comparisons.map(([label, observeValue, enforceValue]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{observeValue}</td>
                <td>{enforceValue}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Open either audit to see per-event scores. Overall risk combines rules and model signals. The supervised ML
        score estimates bot likelihood, and the baseline anomaly score measures deviation from the frozen human
        baseline. Hard policy denials set overall risk to 100.
      </p>
      <Evidence mode="Observe" run={observe} />
      <Evidence mode="Enforce" run={enforce} />
    </section>
  );
}

export default function SecurityReplay() {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ReplayResponse | null>(null);
  const [error, setError] = useState('');

  async function runReplay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    setReport(null);
    setError('');
    setBusy(true);
    try {
      const response = await fetch('/api/security/replay', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fixture: fields.get('fixture'),
          seed: Number(fields.get('seed')),
          participants: Number(fields.get('participants')),
          inventory: Number(fields.get('inventory')),
          profile: fields.get('profile'),
        }),
      });
      const result = await response.json() as ReplayResponse | { ok: false; error: string };
      if (!result.ok) throw new Error(result.error);
      if (!response.ok) throw new Error('Security replay failed.');
      setReport(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Security replay failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card" aria-labelledby="replay-config-title">
        <h2 id="replay-config-title">Fixed-fixture replay</h2>
        <p>
          Fixture events run through the risk engine against an isolated sale. Both modes enforce queue authorization,
          holds, and purchase limits. Observe records behavioral flags. Enforce applies them to security-service checkout decisions.
        </p>
        <form method="post" onSubmit={runReplay} aria-busy={busy}>
          <fieldset className="inline-fields security-evaluation-fields" disabled={busy} aria-label="Replay configuration">
            <label>
              Fixture
              <select name="fixture" defaultValue={replayDefaults.fixture}>
                {Object.entries(replayFixtures).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </label>
            <label>
              Identity profile
              <select name="profile" defaultValue={replayDefaults.profile}>
                {Object.entries(replayProfiles).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </label>
            {([
              ['seed', 'Reproducibility seed'],
              ['participants', 'Participants'],
              ['inventory', 'Starting ticket inventory'],
            ] as const).map(([field, label]) => (
              <label key={field}>
                {label}
                <input name={field} type="number" required {...replayRanges[field]} defaultValue={replayDefaults[field]} />
              </label>
            ))}
          </fieldset>
          <button type="submit" disabled={busy}>{busy ? 'Running security replay…' : 'Run security replay'}</button>
        </form>
        <p role="status">{busy ? 'Evaluating both modes…' : report ? 'Replay complete.' : ''}</p>
        {error && <p className="role-warning" role="alert">{error}</p>}
      </section>
      {report && <ReplayReport report={report} />}
    </>
  );
}
