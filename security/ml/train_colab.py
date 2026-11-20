"""
FairTickets — Colab Pro / Offline ML Training & Comparison Script
-----------------------------------------------------------------
Trains L2 Logistic Regression (exportable directly to security/src/ml-model.json)
and GradientBoostingClassifier on behavioral + account-graph features, and
evaluates both on a held-out shifted distribution.

Usage (in Google Colab Pro or local Python with numpy/scikit-learn):
    python security/ml/train_colab.py --out security/src/ml-model.json
"""

import argparse
import json
import random
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.preprocessing import StandardScaler

FEATURE_NAMES = [
    "queueToReserveMs",
    "reserveToCheckoutMs",
    "interEventMeanMs",
    "interEventCv",
    "eventsPerMinute",
    "sessionEventCount",
    "skippedReservation",
    "abandonmentRatio",
    "clusterAccountCount",
    "competingInSaleCount",
    "sharedIdentifierCount",
]


def generate_dataset(count: int, seed: int, shift_ms: float = 0.0):
    rng = random.Random(seed)
    X, y = [], []
    for _ in range(count):
        r = rng.random()
        if r < 0.36:
            t1 = rng.uniform(1000 + shift_ms, 8000)
            t2 = rng.uniform(1200 + shift_ms, 10000)
            mean = (1000 + t1 + t2) / 3.0
            cv = rng.uniform(0.20, 0.85)
            epm = min(240.0, (4 * 60_000.0) / max(1500.0, 1000 + t1 + t2))
            X.append([t1, t2, mean, cv, epm, rng.randint(3, 5), 0, rng.uniform(0.1, 0.35) if rng.random() < 0.08 else 0.0, 1, 1, 0])
            y.append(0)
        elif r < 0.48:
            t1 = rng.uniform(750 + shift_ms, 2200)
            t2 = rng.uniform(850 + shift_ms, 2600)
            mean = (900 + t1 + t2) / 3.0
            cv = rng.uniform(0.18, 0.55)
            epm = min(240.0, (4 * 60_000.0) / max(1200.0, 900 + t1 + t2))
            X.append([t1, t2, mean, cv, epm, 4, 0, 0.0, 1, 1, 0])
            y.append(0)
        elif r < 0.66:
            t1 = rng.uniform(80, 420 + shift_ms * 0.15)
            t2 = rng.uniform(90, 460 + shift_ms * 0.15)
            skip = 1 if rng.random() < 0.65 else 0
            mean = t1 if skip else (200 + t1 + t2) / 3.0
            cv = rng.uniform(0.01, 0.14)
            X.append([t1, t2, mean, cv, rng.uniform(95, 240), 3 if skip else 4, skip, rng.uniform(0.3, 0.8) if rng.random() < 0.25 else 0.0, 1, 1, 0])
            y.append(1)
        elif r < 0.84:
            cs = rng.randint(3, 50)
            X.append([rng.uniform(150, 1200), rng.uniform(200, 1500), rng.uniform(180, 1100), rng.uniform(0.02, 0.22), rng.uniform(55, 220), rng.randint(2, 4), 1 if rng.random() < 0.5 else 0, rng.uniform(0.3, 0.9) if rng.random() < 0.3 else 0.0, cs, rng.randint(3, cs), rng.randint(1, 2)])
            y.append(1)
        else:
            has_cluster = rng.random() < 0.5
            cs = rng.randint(3, 12) if has_cluster else 1
            X.append([rng.uniform(120, 700), rng.uniform(400, 2000), rng.uniform(200, 900), rng.uniform(0.03, 0.25), rng.uniform(60, 210), rng.randint(3, 6), 0, rng.uniform(0.6, 1.0), cs, cs, 1 if has_cluster else 0])
            y.append(1)
    return np.array(X, dtype=np.float64), np.array(y, dtype=np.int32)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="security/src/ml-model.json")
    args = parser.parse_args()

    X_train, y_train = generate_dataset(1400, seed=20261121, shift_ms=0.0)
    X_test, y_test = generate_dataset(700, seed=99118822, shift_ms=120.0)

    scaler = StandardScaler()
    X_train_s = scaler.fit_transform(X_train)
    X_test_s = scaler.transform(X_test)

    lr = LogisticRegression(C=1.0, max_iter=1000, random_state=42)
    lr.fit(X_train_s, y_train)
    lr_probs = lr.predict_proba(X_test_s)[:, 1]
    lr_preds = (lr_probs >= 0.65).astype(int)

    gb = GradientBoostingClassifier(n_estimators=100, max_depth=3, random_state=42)
    gb.fit(X_train, y_train)
    gb_probs = gb.predict_proba(X_test)[:, 1]
    gb_preds = (gb_probs >= 0.65).astype(int)

    print("LogisticRegression held-out ROC-AUC:", round(roc_auc_score(y_test, lr_probs), 4), "F1:", round(f1_score(y_test, lr_preds), 4))
    print("GradientBoosting   held-out ROC-AUC:", round(roc_auc_score(y_test, gb_probs), 4), "F1:", round(f1_score(y_test, gb_preds), 4))

    tn_fp = np.sum((lr_preds == 1) & (y_test == 0))
    tn_total = np.sum(y_test == 0)

    artifact = {
        "modelType": "l2_logistic_regression_behavioral",
        "version": "1.0.0-colab",
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "featureNames": FEATURE_NAMES,
        "means": [round(float(x), 6) for x in scaler.mean_],
        "stds": [round(float(x), 6) for x in scaler.scale_],
        "weights": [round(float(x), 6) for x in lr.coef_[0]],
        "bias": round(float(lr.intercept_[0]), 6),
        "thresholds": {
            "challengeProbability": 0.65,
            "blockProbability": 0.85,
            "minSessionEvents": 3,
        },
        "validationMetrics": {
            "trainSamples": int(len(y_train)),
            "heldOutSamples": int(len(y_test)),
            "heldOutAccuracy": round(float(accuracy_score(y_test, lr_preds)), 4),
            "heldOutPrecision": round(float(precision_score(y_test, lr_preds)), 4),
            "heldOutRecall": round(float(recall_score(y_test, lr_preds)), 4),
            "heldOutFpr": round(float(tn_fp / max(1, tn_total)), 4),
            "heldOutF1": round(float(f1_score(y_test, lr_preds)), 4),
            "heldOutRocAuc": round(float(roc_auc_score(y_test, lr_probs)), 4),
        },
    }

    Path(args.out).write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    print(f"Exported model artifact to {args.out}")


if __name__ == "__main__":
    main()
