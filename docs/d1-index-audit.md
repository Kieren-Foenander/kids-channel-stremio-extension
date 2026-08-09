# D1 index audit

This audit covers production database `kids-channels` after migrations `0020` and `0021` on 9 August 2026. It uses `wrangler d1 insights`, `EXPLAIN QUERY PLAN`, and the per-query `meta.rows_read` returned by D1.

## What caused the usage spike

The largest operations in the 24-hour production sample were the one-time canonical show migration, not normal Household traffic:

| Statement | Executions | Rows read | Rows written | Classification |
| --- | ---: | ---: | ---: | --- |
| Backfill `canonical_shows` | 6 | 12,727,476 | 6,108 | Migration `0020` |
| Backfill `canonical_show_episodes` | 2 | 1,317,324 | 391,488 | Migration `0020` |
| Insert episode metadata | 2,580 | 0 | 7,740 | Approval traffic spanning the schema rollout |

The database contained 641 Households, 2,780 Approved Library entries, 509 canonical shows, 65,248 canonical episodes, and 4,383 Channel Schedule rows. Counting all of those tables is itself a full scan: the diagnostic count read 73,561 rows. A Household count is therefore a poor estimate of application database work.

The old pre-normalization episode-list query also remained in the 24-hour lookback window: 200 executions read 452,586 rows. It is historical traffic from before the merged query shape and should age out of insights rather than receive an index for a schema it no longer targets.

## Recurring access paths

Authentication is already efficient. The production query `SELECT ... FROM households WHERE secret = ?` ran 5,977 times and read 5,973 rows in total. `UNIQUE(secret)` maintains `sqlite_autoindex_households_2`, so the explicit `households_secret_idx` duplicates the same key. Migration `0022` drops only the redundant index; its integration test verifies the automatic index remains selected and duplicate secrets remain rejected.

Automatic Preparation Run reconciliation was the material recurring scan:

| Measurement | Before `0022` | After `0022` fixture |
| --- | ---: | ---: |
| Households | 641 | 641 |
| TorBox-configured Households | 1 | 1 |
| Production rows read per reconciliation | 642 | Capture after rollout |
| Household access set | All 641 table rows | The 1 partial-index entry |
| Query plan | `SCAN household`; temporary B-tree for ordering | `SCAN household USING INDEX households_automatic_preparation_idx` |

The production 24-hour sample contained 26 reconciliations with 16,696 total rows read, averaging 642. The before plan was captured directly against production. D1's local Wrangler runtime does not expose `meta.rows_read`, so the integration fixture does not claim a local D1 row count. It uses the same 641-to-1 Household distribution and exact application SQL, and fails unless results stay identical, the partial index is selected, and the temporary sort disappears. After production rollout, repeat the commands below to record the live after measurement.

The new `(created_at, id)` index contains only rows where `torbox_token_ciphertext IS NOT NULL`. New unconfigured Households therefore add no index write. Connecting or disconnecting TorBox changes one index entry; ordinary Channel, Approved Library, stream-selection, and playback writes do not touch it. This narrowly scoped write cost is justified by eliminating the full Household scan every fifteen minutes.

No other index is added. Current high-frequency lookups already use primary, unique, or explicit Household-first indexes. Adding speculative indexes would increase D1 row writes and storage without measured production benefit.

## Rollout and verification

Apply the migration with:

```sh
pnpm db:migrate:remote
```

Migration `0022` runs `PRAGMA optimize` after changing the schema so D1 refreshes planner statistics when needed. Then inspect the last day of statements:

```sh
pnpm exec wrangler d1 insights kids-channels --time-period 1d --sort-by reads --sort-direction DESC --limit 50
```

Use the automatic reconciliation SQL from `ensureAutomaticTvPreparationForAll` with `EXPLAIN QUERY PLAN`; it must report `households_automatic_preparation_idx` and no temporary B-tree. Its D1 result metadata should approach the number of configured Households rather than all Households.

If production behaviour regresses, apply `migrations/rollback/0022_restore_household_indexes.sql` with `wrangler d1 execute --remote --file`. This removes the partial index, recreates `households_secret_idx`, and refreshes planner statistics. Secret lookup correctness does not depend on rollback because the `UNIQUE(secret)` index remains throughout.
