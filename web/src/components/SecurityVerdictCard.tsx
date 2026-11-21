'use client';
import { useState } from 'react';
import type { ApiMutationResponse } from '@/lib/types';

export default function SecurityVerdictCard({
  message,
  busy,
  onSubmitChallenge,
}: {
  message: ApiMutationResponse | null;
  busy: boolean;
  onSubmitChallenge?: (challengeId: string, token: string, answer: string) => void;
}) {
  const [challengeAnswer, setChallengeAnswer] = useState('');
  const sec = message?.securityDecision;
  if (!sec) return null;

  const chl = message?.stepUpChallenge;

  return (
    <section className="card" aria-live="polite">
      <div className="card-head">
        <h2>Live Security &amp; ML Verdict</h2>
        <span
          className={`pill ${
            sec.decision === 'ALLOW'
              ? 'ok'
              : sec.decision === 'BLOCK'
                ? 'danger'
                : 'warn'
          }`}
        >
          {sec.decision || 'ALLOW'} · Risk {sec.riskScore ?? 0}/100
        </span>
      </div>
      <div className="metrics-grid">
        <div className="metric">
          <span>Supervised ML Score</span>
          <strong>{sec.mlScore ?? 0} / 100</strong>
          <small>Decision ID: {sec.decisionId || '—'}</small>
        </div>
        <div className="metric">
          <span>Unsupervised Anomaly</span>
          <strong>{sec.unsupervisedAnomalyScore ?? 0} / 100</strong>
          <small>Live Welford Human Baseline</small>
        </div>
        <div className="metric">
          <span>Reasons</span>
          <strong>
            {sec.reasons && sec.reasons.length > 0 ? sec.reasons.join(', ') : 'Clean ALLOW'}
          </strong>
          <small>Enforced server-side before Anvil tx</small>
        </div>
      </div>
      {chl && onSubmitChallenge && (
        <div style={{ marginTop: 12 }}>
          <p>
            <strong>{chl.prompt}</strong>
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
                const answer = challengeAnswer.trim();
                setChallengeAnswer('');
                onSubmitChallenge(chl.challengeId, chl.token, answer);
              }}
            >
              {busy ? 'Verifying…' : 'Submit Verification & Retry'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
