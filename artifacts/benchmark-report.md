# FairTickets — Seven-Benchmark Results

Run timestamp: 2026-11-20T17:08:17.454Z
Chain: Anvil 1.7.1 (chainId 31337, shanghai, 30M gas limit)
Template bytecode hash (pre-immutable): `0xb3dd3a406d2fff59f8907164dbbff57dcea32538cdfa16288cc706aa37e9fea7`
Deployed runtime codeHash (with constructor immutables): `0x05c9bde758933d7bfc7542d95dd678374100eef3315d16064b7453fd18fcaaef`

| # | Benchmark | Severity | Result | Duration | Key Metrics |
|---|---|---|---|---|---|
| 1 | Fair allocation | Critical | PASS | 4176 ms | `{"entrants":1000,"winners":100,"uniqueWinners":100,"drawGasUsed":5377654,"independentDrawVerified":true,"queuePriorityReservations":80,"lotteryApplicants":80,"lotteryReservations":20}` |
| 2 | Duplicate-entry resistance | Critical | PASS | 3054 ms | `{"attempts":1000,"succeeded":1,"rejected":999,"onChainEntrantsCount":1}` |
| 3 | No overselling | Critical | PASS | 8820 ms | `{"burstRequests":1000,"acceptedByMempool":1000,"rpcRejected":0,"peakConcurrency":1000,"burstDurationMs":72,"blocksToDrain":2,"committedSales":100,"rejectedClaims":900,"reconciledOwners":100,"winnerRetryAttempts":1000,"winnerRetrySales":0,"organiserProceedsWei":"20000000"}` |
| 4 | Resale price cap | Critical | PASS | 399 ms | `{"aboveFaceRejected":true,"aboveLastPaidRejected":true,"mismatchedPriceRejected":true,"twoBuyersOneListingRaceResolved":true,"oneBuyerTwoTicketsRejected":true,"failedPayoutIsolated":true}` |
| 5 | Credential invalidation | High | PASS | 348 ms | `{"aToBStaleRejected":true,"bFreshAdmitted":true,"aToBToAOriginalRejected":true,"aToBToAFreshAdmitted":true,"admittedCount":2}` |
| 6 | Forgery rejection | High | PASS | 251 ms | `{"forgeriesTested":6,"allRejected":true,"admittedCount":0}` |
| 7 | One-time admission | Critical | PASS | 11572 ms | `{"burstRequests":100,"acceptedByMempool":100,"rpcRejected":0,"peakConcurrency":100,"burstDurationMs":14,"blocksToDrain":1,"concurrentScans":100,"admitted":1,"denied":99,"admittedGas":84030,"failedGasTotal":3480633,"cliConcurrentSameScanLockVerified":true,"cliConcurrentSharedWalletVerified":true,"cliCrashResumePendingVerified":true,"cliCrashResumeConfirmedGapRaceVerified":true,"cliCrashResumePreJournalVerified":true,"cliKernelLockSigkillContentionVerified":true}` |
