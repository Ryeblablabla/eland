# Invalid mixed-build matrix

Do not use `baseline-civ61-breaks-20y-20260822.json` as baseline or candidate evidence.

The matrix began against the pre-change backend, but `dist-server/run-evolution-worker.mjs` was rebuilt at `2026-08-22T19:00:48+08:00` while the matrix was still running. Later cells therefore loaded a different implementation. The artifact is retained only for auditability and is excluded from every comparison and conclusion.
