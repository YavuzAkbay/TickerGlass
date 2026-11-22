# Design: scheduled backups (roadmap 2.4)

Nightly server backup to a local folder and/or any S3-compatible store (AWS S3, MinIO, Backblaze
B2, Wasabi, Garage, R2), with retention, and restore from the same files. Admin feature; covers
every user (it is the whole-database backup that "Download backup" already produces).

## Scope

- **SQLite only.** Postgres installs get a clear "not supported, use pg_dump" status (as the download
  does today, 501). Docs show a pg_dump sidecar example.
- Per-user bundles (`/api/export`) stay as they are — that's the user-level tool.

## Snapshot

1. Online copy with the sqlite3 backup API from a read-only connection (same as
   `GET /server/backup` — extract that into `backups/snapshot.py` and use it in both places).
2. Unless `BACKUP_INCLUDE_CACHE=true`: on the **copy**, clear the market cache exactly as
   `POST /server/cache/clear` does (reuse its function so app_meta cache-gate invariants hold), then
   `VACUUM`. Restored servers refetch market data.
3. `PRAGMA integrity_check` on the copy must return `ok`; record `alembic_version` and app version.
4. gzip (level 6), then optional encryption (below). Streamed through temp files in the data dir's
   `backups-tmp/` (same filesystem, cleaned at startup), never whole-file in memory.

File name: `tickerglass-<UTC yyyymmddTHHMMSSZ>.db.gz` (+`.enc` when encrypted). A sidecar is not
used; metadata (app version, schema revision, sha256 of the final file, size, encrypted flag) goes in
a small JSON `tickerglass-<ts>.json` next to it (and as S3 object metadata isn't relied on). The
JSON also carries `instanceId` (see Retention).

## Encryption (optional, `BACKUP_PASSPHRASE`)

`cryptography` (already a dependency via pyjwt[crypto]) — chunked AES-256-GCM:
header `b"TGBK1\0"` + scrypt params (n=2**15, r=8, p=1) + 16-byte salt + 8-byte nonce prefix; key =
scrypt(passphrase, salt); body = chunks of 1 MiB plaintext, each `AESGCM.encrypt(nonce_prefix ||
uint32 counter, chunk, aad=header || uint32 counter || final_flag)`, written as `uint32 len || ct`.
The final chunk carries `final_flag=1` (truncation detected). Decrypt rejects unknown versions, bad
params bounds, reordered/truncated/extra chunks. Module `backups/crypto.py` with
`encrypt_stream(src, dst, passphrase)` / `decrypt_stream(src, dst, passphrase)`; CLI
`tickerglass-api backup decrypt <in> <out>` so a backup can be opened without the server.
Passphrase loss = backup unreadable (docs say so loudly). Minimum length 12.

## Targets

- **Local:** `BACKUP_DIR` (absolute path; created 0700; warn in status when it is on the same
  filesystem as the database, i.e. not protection against disk loss).
- **S3:** `BACKUP_S3_ENDPOINT` (e.g. `https://s3.eu-central-1.amazonaws.com`,
  `http://minio:9000`), `BACKUP_S3_BUCKET`, `BACKUP_S3_PREFIX` (default `tickerglass/`),
  `BACKUP_S3_REGION` (default `us-east-1`), `BACKUP_S3_ACCESS_KEY_ID`,
  `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_PATH_STYLE` (default `true`). `BACKUP_PASSPHRASE` and
  `BACKUP_S3_SECRET_ACCESS_KEY` are `SecretStr` in `Settings` (read with `.get_secret_value()` /
  `Settings.backup_passphrase_value`, `backup_s3_secret_value`); `Settings` has
  `hide_input_in_errors=True` (a startup `ValidationError` never echoes a value, nor — for a
  model-level check — every input) and every secret field has `repr=False`.
  `backups/s3.py`: stdlib SigV4 client — `put_object(key, file, size, sha256_hex)`,
  `list_objects(prefix) -> [(key, size, last_modified)]` (ListObjectsV2 with continuation),
  `get_object(key, dst_file)`, `delete_object(key)`, `head_bucket()` (used by "Test").
  Signed payload hash (sha256 computed while writing the temp file). Single PUT (≤5 GiB; refuse
  bigger with a clear error). HTTP via urllib, 60 s timeout (stream), no redirects, http/https only,
  private addresses allowed (operator-configured, like ntfy/Gotify). Errors expose S3 error _code_
  only (`AccessDenied`, `NoSuchBucket`), never signatures or keys. Secret never logged.
- Both targets may be set; each gets the same file; one failing doesn't stop the other (run result
  is `partial`).
- **Fetching** (restore from a target) goes through a capped writer: more than
  `BACKUP_RESTORE_MAX_MB` (default 8192) is refused and the partial file removed.

## Schedule and retention

- `BACKUP_AT` (`HH:MM`, default `03:30`) + `BACKUP_TZ` (IANA, default = `SCREENER_TZ` setting or
  UTC), daily. Enabled when at least one target is configured and `BACKUP_ENABLED` isn't `false`.
- Scheduler task in the API lifespan (pattern of the screener scheduler: injected clock/sleep,
  sleeps in slices), job lease `backup` in `job_leases` so only one process runs it. On startup, if
  the last successful run is older than 26 h, run once after a 5 min delay (missed-night catch-up).
- Retention per target, GFS over **our** files only (`tickerglass-<ts>.db.gz[.enc]` + matching
  `.json`; never touch anything else): keep the newest `BACKUP_KEEP_DAILY` (7) days' latest backup,
  newest `BACKUP_KEEP_WEEKLY` (4) ISO weeks' latest, newest `BACKUP_KEEP_MONTHLY` (6) months' latest;
  manual runs count like scheduled ones. Never delete the backup just made; never delete when the
  current run failed.
- **Instance id.** A random `instance_id` lives in `app_meta` (`backups/instance.py`, created on
  first use, before the snapshot so it is inside the backup too) and is written into every backup's
  `.json` (`instanceId`). Retention considers only files whose `.json` has our id (`Target.read_meta`,
  `.json` capped at 64 KiB): files without a `.json`, with an unreadable one, or with another id
  are neither deleted nor counted towards what is kept. A restored database carries its old id
  (same server lineage, so it keeps managing the same series). Operators use one prefix/folder per
  server (documented); backups from before the id existed are never pruned automatically.
- Run record: `backup_runs` table (id, started_at, finished_at, trigger `schedule|manual`, status
  `ok|partial|failed`, file name, size, per-target results JSON, error text (sanitized)), keep 100.
  New migration.

## Restore

Never overwrite a live database. Two-phase:

1. **Stage:** from a local target file, an S3 object, or an uploaded file (admin UI, multipart,
   streamed to disk, size limit `BACKUP_UPLOAD_MAX_MB` default 2048; the staged backup is further
   limited by `BACKUP_RESTORE_MAX_MB`, below). Decrypt if needed (passphrase
   from settings or supplied in the request for an uploaded file — never stored), gunzip to
   `<data>/restore-pending.db`, then validate (`restore.validate_db`, run again at apply time):
   - SQLite header, `integrity_check` ok (with `trusted_schema=OFF`).
   - `alembic_version` holds a revision known to this code (≤ head; newer → refuse "backup is from a
     newer TickerGlass"). **Any** known revision is accepted — pre-2.2 backups and "Download
     backup" files included; the migrations upgrade them at startup (the 2.2 migration creates the
     Owner and puts every row under it). The `users` table is required only from the multi-user
     revision (`a91c4d7e2b60`) on, ordered by `db.migration_chain()`.
   - **No active content.** The candidate is opened read-only with `PRAGMA trusted_schema=OFF` (and
     `SQLITE_DBCONFIG_DEFENSIVE` through `Connection.setconfig` where Python has it, 3.12+), and is
     refused if it has any trigger or view (a crafted `AFTER INSERT ON users ... SET is_admin=1`
     would run inside the server), a virtual table, a generated column, an index on an expression
     (`PRAGMA index_xinfo` reports `cid = -2`) or a partial index (`PRAGMA index_list`). Chosen over
     a name allow-list because it is structural (SQLite's own parser decides, no regex over SQL),
     and a name list would have to enumerate the indexes of every historical revision; our own
     migrations create plain-column indexes only (`test_the_real_schema_passes_...`).
   - **Limits.** `BACKUP_RESTORE_MAX_MB` (default 8192; separate from the upload limit
     `BACKUP_UPLOAD_MAX_MB`) caps the file as read (also while fetching from a target) and its
     decompressed size. Before unpacking, free space in the work folder must cover
     `min(cap, 2 × expected size)` (gzip's ISIZE trailer when plausible, else the cap; plus the
     decrypted copy for an encrypted file) — otherwise a clear error (HTTP 507).
   - Writes `<data>/restore-pending.json` (source, staged_at, revision). Replacing meta and db
     happens under a process lock (`threading.Lock`) plus an `O_EXCL` lock file
     (`.restore-stage.lock`, stale after 60 s) so two concurrent stagings never leave one's meta
     next to the other's database; cancel takes the same lock.
2. **Apply at startup**, before migrations (`restore.startup_restore`): only while holding the
   server lock (`.tickerglass-server.lock`) — it first clears `backups-tmp/`, then, if
   `restore-pending.db` exists and validates again, moves the current DB (and `-wal`/`-shm`) to
   `<data>/pre-restore-<ts>.db`, moves the staged file in, logs WARNING, then runs migrations as
   usual (older backups upgrade). Keep the last 2 pre-restore copies (ordered by `(stamp, counter)`
   parsed from the name, not by text; other names are never pruned). A failed validation leaves the
   live DB untouched and records the error in status.
   - **No lock** (another process holds the data folder): log ERROR, do **not** clean `backups-tmp/`
     and do **not** apply; the server still starts. A staged restore stays staged and
     `restore-result.json` records `failed` with "another process holds this data folder". (A
     platform without `fcntl` cannot lock at all and proceeds as before.)
   - **Migrations fail after an applied restore:** roll back (`restore.rollback_applied`) — drop the
     restored file, move the pre-restore copy back with its `-wal`/`-shm`, record `failed` in
     `restore-result.json` (reason: the exception type only, never its message), re-raise so the
     server does not start on a half-migrated file.

- UI says "Restart the server to finish the restore" (AIO/compose restart policies make
  `docker restart` enough). Cancel = delete staged files.
- CLI: `tickerglass-api backup run`, `backup list`, `backup restore <path|s3://key>` (stages; with
  `--apply-now` only when the server is not running — detect via the lease/pid and refuse
  otherwise), `backup decrypt`.
- After restore, sessions stay valid only if `AUTH_SECRET` / `.session_secret` match (they live
  outside the DB) — documented.

## API (admin only)

- `GET /api/backups` → `{enabled, supported, schedule:{at,tz,next}, targets:[{kind, label,
configured, warning?}], encrypted: bool, includeCache: bool, retention:{daily,weekly,monthly},
running: bool, last: run|null, runs:[…10], files:[{target, name, size, createdAt, encrypted}]
(merged, newest first), fileErrors:[{target, error}] (targets that could not be listed),
pending: {source, stagedAt, revision}|null, lastRestore: {status: 'applied'|'failed', at, source,
revision?, error?, preRestore?}|null}`. A run is `{id, startedAt, finishedAt, trigger, status,
fileName, size, results:[{target, ok, error, deleted?, retentionError?}], error}`.
- `POST /api/backups/run` → 202 `{runId}` (409 if running). `GET /api/backups/runs/{id}`.
- `POST /api/backups/test` → `{targets:[{kind, label, ok, error}]}` (S3 `HEAD bucket`, local dir
  writable).
- `POST /api/backups/restore {target, name}` / `POST /api/backups/restore/upload` (multipart
  `file`, optional `passphrase`) → stages; `DELETE /api/backups/restore` cancels → 200
  `{cancelled}`. The upload must send the header `X-TickerGlass-Request: 1` (403 otherwise): a
  multipart POST is a "simple" cross-site request without a CORS preflight, and a custom header
  cannot be added cross-site without one. The body is read and written to disk on a worker thread
  (`run_in_threadpool`), not on the event loop.
- `GET /api/backups/files/{target}/{name}` → download (admin). An S3 object is fetched to a temp
  file that is unlinked as soon as it is open and streamed from the open handle
  (`StreamingResponse`; the generator's `finally` closes it), so a client that disconnects leaves
  nothing behind.
- `/server/status` (admin) gains `backup: {enabled, lastStatus, lastAt, pending}`.

## Web (Settings → Server, admin)

New "Backups" section: schedule + targets summary (with the same-filesystem warning), last run
status (running state, a failed cleanup, targets that could not be listed), retention and cache
summary, Run now, Test targets, list of backups (download, restore → confirm dialog explaining the
restart), "Restore from file…" (upload + optional passphrase), pending-restore banner with Cancel,
and the outcome of the last restore (applied, or not applied with the reason).
Strings via i18n. Postgres: section shows the pg_dump hint.

## Docs

`docs/self-hosting.md` "Back up and restore": scheduled backups, targets (MinIO / B2 / R2
examples), encryption + passphrase warning, retention, restore (UI, CLI, manual), Postgres pg_dump
sidecar. `.env.example`, `docker-compose.yml` pass-through, deploy templates (Unraid advanced vars,
Helm values) + `deploy/check.py` stays green. Roadmap 2.4 → `done`.
