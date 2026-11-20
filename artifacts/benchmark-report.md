# FairTickets — Seven-Benchmark Results

Run timestamp: 2026-11-20T10:16:55.838Z
Chain: Anvil 1.7.1 (chainId 31337, shanghai, 30M gas limit)
Template bytecode hash (pre-immutable): `0x64d3ee3ed5b550c3b0c9064fdbc4d3c47844c59170dfc412a49e706bb8e19f24`
Deployed runtime codeHash (with constructor immutables): `0x672fdf1ddfd0e12810142b5355105bf7a08723c9ca7b7d2f4e715f2bf583ef87`

| # | Benchmark | Severity | Result | Duration | Key Metrics |
|---|---|---|---|---|---|
| 1 | Fair allocation | Critical | PASS | 4144 ms | `{"entrants":1000,"winners":100,"uniqueWinners":100,"drawGasUsed":7268397,"independentDrawVerified":true}` |
| 2 | Duplicate-entry resistance | Critical | PASS | 2985 ms | `{"attempts":1000,"succeeded":1,"rejected":999,"onChainEntrantsCount":1}` |
| 3 | No overselling | Critical | PASS | 9136 ms | `{"burstRequests":1000,"acceptedByMempool":1000,"rpcRejected":0,"peakConcurrency":1000,"burstDurationMs":83,"blocksToDrain":2,"committedSales":100,"rejectedClaims":900,"reconciledOwners":100,"winnerRetryAttempts":1000,"winnerRetrySales":0,"organiserProceedsWei":"20000000"}` |
| 4 | Resale price cap | Critical | PASS | 417 ms | `{"aboveFaceRejected":true,"aboveLastPaidRejected":true,"mismatchedPriceRejected":true,"twoBuyersOneListingRaceResolved":true,"oneBuyerTwoTicketsRejected":true,"failedPayoutIsolated":true}` |
| 5 | Credential invalidation | High | PASS | 421 ms | `{"aToBStaleRejected":true,"bFreshAdmitted":true,"aToBToAOriginalRejected":true,"aToBToAFreshAdmitted":true,"admittedCount":2}` |
| 6 | Forgery rejection | High | PASS | 378 ms | `{"forgeriesTested":6,"allRejected":true,"admittedCount":0}` |
| 7 | One-time admission | Critical | PASS | 6909 ms | `{"burstRequests":100,"acceptedByMempool":100,"rpcRejected":0,"peakConcurrency":100,"burstDurationMs":16,"blocksToDrain":1,"concurrentScans":100,"admitted":1,"denied":99,"admittedGas":84054,"failedGasTotal":3483009,"cliConcurrentSameScanLockVerified":true,"cliConcurrentSharedWalletVerified":true,"cliCrashResumePendingVerified":true,"cliCrashResumeConfirmedGapRaceVerified":true,"cliCrashResumePreJournalVerified":true}` |
