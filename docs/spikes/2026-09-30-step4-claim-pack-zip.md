# Spike: the claim pack's ZIP, streamed (step 4, T0; D158, D201)

Date: 2026-09-30. Step-4 plan, Task 0. Result: **passes.** `yazl` 3.3.1 zips a 1 MB report and 200
photos (44 MB) straight from the blob store in 0.4–1.4 s at a peak of about 105–140 MB RSS for the
whole process.

**Store, don't deflate:** photos and PDFs are already compressed. With `compress: false` and each
entry's `size` given, yazl tells the exact ZIP size before writing anything, so on S3 the
`outputStream` can go straight into a `PutObject` with that `Content-Length`.

The `BlobStore` interface doesn't allow that today:

- `put(key, file, {contentType, bytes})` takes a local file;
- `assertBlobKey()` knows no ZIP key.

So T18 either spools to the data volume's `tmp/` and `put()`s (works now, both drivers), or adds a
`putStream`. See the end.

Code: `docs/spikes/code/step4/zip/run.ts`. Nothing was merged into `apps/`. The run creates its own
bucket and temp directory and removes both. To reproduce, with the dev RustFS up:

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
docker compose -f compose.dev.yaml --profile s3 up -d s3
cd apps/server && NODE_OPTIONS=--expose-gc pnpm exec tsx ../../docs/spikes/code/step4/zip/run.ts
docker compose -f compose.dev.yaml --profile s3 rm -sf s3
```

## Versions

| Package | Version | Licence | Checked |
|---|---|---|---|
| `yazl` | 3.3.1 | MIT | `npm view` 2026-09-30; dep `buffer-crc32` ^1.0.0 |
| `@types/yazl` | 3.3.1 | MIT | `npm view` 2026-09-30 |

T2 pinned both in `apps/server/package.json`.

**The API** (read in `@types/yazl/index.d.ts` and yazl's README):

- `addReadStreamLazy(name, {size, compress}, cb => cb(null, stream))` opens each source only when
  its turn comes, so 200 blobs never hold 200 open streams or sockets.
- `end(options, calculatedTotalSizeCallback)` reports the eventual size, or `-1` when it can't
  know. The README says it can know only with compression off everywhere and `size` given for
  every stream.

## The run

The sources are 200 noise JPEGs at 800×600 (about 220 KB each), put through the real drivers
(`LocalBlobStore` under a temp `KEPT_DATA_DIR`, and `S3BlobStore` on RustFS), plus a 1 MB buffer
standing in for the report PDF. RSS is the whole Node process, sampled every 20 ms. It includes
the AWS SDK and sharp, loaded before the first run.

| Path | Time | ZIP | Size known before writing | Process RSS |
|---|---|---|---|---|
| A. local store → temp file (then `put()`) | 357 ms | 44 MB, `unzip -t` clean | 45,985,203 B, **exact** | 104 → 104 MB |
| B. S3 store → temp file → `PutObject` from the file (what `S3BlobStore.put` does) | 1,437 ms | 44 MB | exact | 104 → 106 MB |
| C. S3 store → `outputStream` straight into `PutObject`, `ContentLength` from yazl | 936 ms | 44 MB, read back and `unzip -t` clean | exact | 106 → 138 MB |
| D. local store, deflate on → temp file | 1,176 ms | 44 MB (no smaller) | unknown (`-1`) | 143 → 143 MB |

- **Memory stays flat** with the number of files. yazl pipes with backpressure (its README
  "throttling happens appropriately"), and the lazy streams open one at a time.
- **Streaming straight to S3 works.** The SDK takes a stream body with an explicit
  `ContentLength`. It saves the temp file's disk and a second read, at +32 MB RSS for the SDK's
  buffers.
- **Deflate buys nothing and costs time.** JPEG and PDF don't shrink, deflate took 3× longer, and
  the size can't be known. Store every entry (`compress: false`); a CSV in the pack is small
  either way.

## For T18 (claim packs)

- **The ZIP.** A `yazl.ZipFile` with `compress: false` everywhere:
  - the insurance PDF: `addBuffer`, or `addReadStreamLazy` from its render file;
  - the CSV;
  - each attachment via `addReadStreamLazy(name, {size: files.bytes, compress: false}, …)`
    streaming `blobs.stream(originalKey(…))`.

  Names inside the ZIP come from ids and sanitised display names; never a user path.
- **Where it goes.** Pick one:
  1. **Spool, then `put()`** (no interface change). Pipe `outputStream` into a file under
     `FileStorage.tmpDir`, then `blobs.put(key, file, {contentType: 'application/zip', bytes})`.
     This works on both drivers today and needs disk equal to the pack's size, briefly. The
     report job already spools its PDF the same way.
  2. **`putStream(key, stream, {contentType, bytes})` on `BlobStore`.** Local writes a temp file
     beside the destination and renames it, which `put()` already does. S3 sends `PutObject` with
     the stream and `ContentLength: bytes`, as in C. This saves a copy on S3.

  Start with 1: it's the smaller change, and the data volume already holds `tmp/`.
- **The key.** `assertBlobKey()` allows only `f/…`, `d/…` and `r/<runId>.pdf`, so a pack needs a
  new id-built shape, e.g. `x/<exportRunId>.zip`, added to `blob-store.ts` with its test (the
  purge-exports job deletes it). Q19: stored as a blob keyed by the run, not a `files` row.
- **Limits.** 200 photos took under 1.5 s. The 1,800 s `claim-pack` policy (T2) leaves room for a
  pack of thousands of files over a slow S3, with progress in `export_runs.progress_done`.

The iPhone half, downloading into Files, is on the device checklist.
