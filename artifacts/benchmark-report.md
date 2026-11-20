# FairTickets — Seven-Benchmark Results

Run timestamp: 2026-11-20T09:29:32.708Z
Chain: Anvil 1.7.1 (chainId 31337, shanghai, 30M gas limit)
Contract codeHash: `0x64d3ee3ed5b550c3b0c9064fdbc4d3c47844c59170dfc412a49e706bb8e19f24`

| # | Benchmark | Severity | Result | Duration | Key Metrics |
|---|---|---|---|---|---|
| 1 | Fair allocation | Critical | PASS | 4272 ms | `{"entrants":1000,"winners":100,"uniqueWinners":100,"drawGasUsed":7383620,"independentDrawVerified":true}` |
| 2 | Duplicate-entry resistance | Critical | PASS | 3273 ms | `{"attempts":1000,"succeeded":1,"rejected":999,"onChainEntrantsCount":1}` |
| 3 | No overselling | Critical | PASS | 5922 ms | `{"burstRequests":1000,"committedSales":100,"rejectedClaims":900,"winnerRetryAttempts":1000,"winnerRetrySales":0,"organiserProceedsWei":"20000000"}` |
| 4 | Resale price cap | Critical | PASS | 420 ms | `{"aboveFaceRejected":true,"aboveLastPaidRejected":true,"mismatchedPriceRejected":true,"twoBuyersOneListingRaceResolved":true,"oneBuyerTwoTicketsRejected":true,"failedPayoutIsolated":true}` |
| 5 | Credential invalidation | High | PASS | 357 ms | `{"aToBStaleRejected":true,"bFreshAdmitted":true,"aToBToAOriginalRejected":true,"aToBToAFreshAdmitted":true,"admittedCount":2}` |
| 6 | Forgery rejection | High | PASS | 249 ms | `{"forgeriesTested":6,"allRejected":true,"admittedCount":0}` |
| 7 | One-time admission | Critical | PASS | 376 ms | `{"concurrentScans":100,"admitted":1,"denied":99,"admittedGas":84066,"failedGasTotal":3484197}` |
