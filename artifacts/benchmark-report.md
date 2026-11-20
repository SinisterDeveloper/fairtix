# FairTickets — Seven-Benchmark Results

Run timestamp: 2026-11-20T10:19:52.788Z
Chain: Anvil 1.7.1 (chainId 31337, shanghai, 30M gas limit)
Template bytecode hash (pre-immutable): `0x64d3ee3ed5b550c3b0c9064fdbc4d3c47844c59170dfc412a49e706bb8e19f24`
Deployed runtime codeHash (with constructor immutables): `0x4a29eb9b49a266b6a0fdedc79b1653f2503da3a6833637ea509adb71055821ec`

| # | Benchmark | Severity | Result | Duration | Key Metrics |
|---|---|---|---|---|---|
| 1 | Fair allocation | Critical | PASS | 4177 ms | `{"entrants":1000,"winners":100,"uniqueWinners":100,"drawGasUsed":7271891,"independentDrawVerified":true}` |
| 2 | Duplicate-entry resistance | Critical | PASS | 3086 ms | `{"attempts":1000,"succeeded":1,"rejected":999,"onChainEntrantsCount":1}` |
| 3 | No overselling | Critical | PASS | 9184 ms | `{"burstRequests":1000,"acceptedByMempool":1000,"rpcRejected":0,"peakConcurrency":1000,"burstDurationMs":76,"blocksToDrain":2,"committedSales":100,"rejectedClaims":900,"reconciledOwners":100,"winnerRetryAttempts":1000,"winnerRetrySales":0,"organiserProceedsWei":"20000000"}` |
| 4 | Resale price cap | Critical | PASS | 434 ms | `{"aboveFaceRejected":true,"aboveLastPaidRejected":true,"mismatchedPriceRejected":true,"twoBuyersOneListingRaceResolved":true,"oneBuyerTwoTicketsRejected":true,"failedPayoutIsolated":true}` |
| 5 | Credential invalidation | High | PASS | 349 ms | `{"aToBStaleRejected":true,"bFreshAdmitted":true,"aToBToAOriginalRejected":true,"aToBToAFreshAdmitted":true,"admittedCount":2}` |
| 6 | Forgery rejection | High | PASS | 250 ms | `{"forgeriesTested":6,"allRejected":true,"admittedCount":0}` |
| 7 | One-time admission | Critical | PASS | 6987 ms | `{"burstRequests":100,"acceptedByMempool":100,"rpcRejected":0,"peakConcurrency":100,"burstDurationMs":22,"blocksToDrain":1,"concurrentScans":100,"admitted":1,"denied":99,"admittedGas":84066,"failedGasTotal":3484197,"cliConcurrentSameScanLockVerified":true,"cliConcurrentSharedWalletVerified":true,"cliCrashResumePendingVerified":true,"cliCrashResumeConfirmedGapRaceVerified":true,"cliCrashResumePreJournalVerified":true}` |
