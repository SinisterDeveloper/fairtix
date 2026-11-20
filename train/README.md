# FairTickets — Colab Pro Training Notebooks (`/train`)

Import these notebooks into **Google Colab Pro** to train and calibrate FairTickets' ML & Unsupervised Baseline artifacts on real-world public datasets:

1. **`01_iliou_web_bot_detection.ipynb`**
   - **Dataset:** *Web Bot Detection Dataset* (Iliou et al., *ACM DTRAP* 2021 — BORDaR).
   - **Trains & compares:** `LogisticRegression`, `GradientBoostingClassifier`, and unsupervised `IsolationForest`.
   - **Exports:** `ml-model.json` → copy to `security/src/ml-model.json`.

2. **`02_kaggle_ecommerce_funnel_baseline.ipynb`**
   - **Dataset:** *Kaggle Ecommerce Clickstream / Website Logs* (`event_time`, `event_type`, `user_session`).
   - **Calibrates:** Real human `view → cart → purchase/abandon` funnel pacing & Welford variance statistics.
   - **Exports:** `human-baseline.json` → copy to `security/src/human-baseline.json` (which `UnsupervisedBaselineDetector` loads automatically and continues updating online from clean `ALLOW` live traces).

### Local CLI Ingestion (Zero Python Dependencies)
You can also ingest downloaded CSVs locally in Node.js:
```powershell
node --experimental-strip-types --no-warnings security/ml/ingest-datasets.ts iliou path/to/iliou_logs.csv security/src/ml-model.json
node --experimental-strip-types --no-warnings security/ml/ingest-datasets.ts kaggle path/to/clickstream.csv security/src/human-baseline.json
```
