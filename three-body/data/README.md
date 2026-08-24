# Local simulation data

This directory is the local runtime and experiment workspace for ELAND. Its
contents are intentionally excluded from Git because runs, checkpoints,
SQLite databases, logs, and raw experiment reports are generated artifacts and
can grow without bound.

The application creates the runtime directories it needs. Existing local data
is not removed when the repository stops tracking it.

Only small, deterministic inputs that are required by automated tests may be
committed under `fixtures/`. SQLite databases and their WAL/SHM files must
remain local. Durable experiment conclusions belong in `docs/`; raw evidence
should be kept in external artifact storage when it needs long-term retention.

Historical documents may still mention their original `data/...` artifact
paths. Those paths are evidence identifiers rather than bundled downloads. A
needed legacy artifact can be recovered from a retained workspace, backup, or
an older Git revision until a dedicated artifact archive is established.
