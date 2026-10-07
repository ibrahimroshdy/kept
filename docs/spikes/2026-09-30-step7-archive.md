# Step 7, Task 0: the archive reader and writer (Z1)

Run on 2026-09-30 on the laptop (M1 Pro, Node 24.21.0), with the local BlobStore and the S3 one
against RustFS (`compose.dev.yaml`, profile `s3`, port 9452). Plan:
[step 7](../plans/2026-09-30-step-7-portability.md), Task 0 and Task 7. Rules: D157, engineering
spec §3.1b.

**Result: pass, except that the 2 GB archive wasn't written to disk** (the disk had under 3 GB
free, shared with other agents). The writer streamed 2 GiB and 4.1 GiB within 41 MiB of RSS; a
300 MiB archive written to disk passes `unzip -t`. Opening a 2 GB export in macOS Archive
Utility is on the device checklist.

| Check | Result |
|---|---|
| Every hostile fixture refused with a named reason, before its cap is inflated | **Pass**, on both stores (table below) |
| The S3 reader reads the central directory and one entry with ranged GETs only | **Pass**: 2 GETs for a Homebox fixture's manifest; 13 + 2 for a 200,001-entry archive. **Only with a block cache**, which T7 must build |
| Writer RSS under 150 MB at `--max-old-space-size=256` | **Pass**: 29 MiB for 2 GiB, 41 MiB for 4.1 GiB |
| The 2 GB archive opens in Archive Utility and `unzip -t` | **Partial**: `unzip -t`, bsdtar and yauzl on a 300 MiB archive from the same writer; 2 GB not written (disk). Archive Utility → device checklist |

Code, throwaway: `docs/spikes/code/step7/` (`z1_reader.ts`, `z1_run.ts`, `z1_probe.ts`,
`z1_write.mjs`, `gen_hostile.py`), with `yauzl` 3.4.0 and `yazl` 3.3.1 pinned in its own
`package.json` (not in the workspace). The server's `LocalBlobStore` and `S3BlobStore` were
imported from `apps/server/src/storage/` unchanged. There is no `i/<runId>.zip` key yet (T2 adds
it), so the spike stored archives under report keys (`r/<uuid>.pdf`), which have the same
id-only shape.

## The reader

`BlobRangeReader extends yauzl.RandomAccessReader`, opened with
`yauzl.fromRandomAccessReaderPromise(reader, size, {lazyEntries: true, decodeStrings: true,
validateEntrySizes: true, strictFileNames: true, autoClose: false})`.

Four things T7 needs that the plan doesn't say:

1. **A block cache for `read()`: required on S3.** yauzl reads the central directory with two
   small `read()`s per entry (the fixed 46 bytes, then the name and extra fields) and each local
   header with two more (`index.js`, `_readEntry` and `readLocalFileHeader`). The default
   `read()` turns each into a `_readStreamForRange()`, which is one ranged GET on S3: about
   400,000 GETs for a 200,000-entry directory *(counted from the source, not run)*. The spike
   overrides `read()` to serve from **1 MiB blocks, at most 16 held (LRU)**, each block one GET;
   `_readStreamForRange()` stays one GET per entry's data. Measured on RustFS: a 22 MB archive
   with 200,001 entries needed **13 GETs (12.9 MB) for its whole directory**, 3.3 s, and one more
   block GET plus one data GET to read `manifest.json`.
2. **An async bridge.** yauzl wants `_readStreamForRange()` to return a stream at once, and
   `BlobStore.stream()` returns a promise. A `PassThrough` is returned immediately and the blob
   stream piped into it when it arrives; an error on either side destroys the other, and closing
   the PassThrough destroys the source (yauzl may `destroy()` a stream it no longer needs).
3. **Ends.** yauzl's `end` is exclusive, `BlobRange.end` inclusive: `{start, end: end - 1}`.
   Confirmed on both drivers (every byte count matched; a short read is an error).
4. **The 100 : 1 ratio needs a floor.** A small, very compressible entry is normal (an empty
   JSON array, a 10 KB run of spaces in a CSV) and passes 100 : 1 easily. The spike judges the
   ratio only once an entry has inflated **more than 1 MiB**, on the declared sizes before
   inflating and on the bytes actually inflated while streaming. Proposed for `limits.ts`:
   `ratioFloorBytes: 1 MiB`.

The order of checks: the archive's size (5 GB) → yauzl opens it (a truncated or non-ZIP file
fails here) → `entryCount` from the end-of-directory record against 200,000 → each entry:
yauzl's name validation (strict), a duplicate name, a symlink (`versionMadeBy >> 8 === 3` and
`(externalFileAttributes >>> 16) & 0o170000 === 0o120000`), encryption, the declared running
total, the declared ratio → then, while reading, a counting `Transform` per entry (ratio on real
bytes, total on real bytes) and yauzl's own `validateEntrySizes`.

## Hostile archives

Made by `gen_hostile.py` (stdlib Python; T7 commits the small ones under `test/fixtures/zip/`, and
regenerates the two large ones in the test). Results were identical on the local store and on
S3:

| Fixture | Size | Refused as | Inflated before refusal |
|---|---|---|---|
| `ratio-1g-zeros.zip`: one entry, 1 GiB of zeros | 1.0 MB | `ratio` (declared 1,073,741,824 / 1,043,638) | 0 |
| the same, **header checks off** (only the streaming counters) | | `ratio` (inflated 104,366,080 from 1,043,638) | 104 MB: 100 × compressed plus one chunk |
| `entries-200001.zip` (ZIP64 by entry count) | 22 MB | `too_many_entries` (200,001 in the directory) | 0, no entry read |
| `symlink.zip`: mode 0120777, made by Unix | 329 B | `symlink` | 0 |
| `dotdot.zip`: `../x` | 233 B | `invalid_name` (yauzl: "invalid relative path") | 0 |
| `absolute.zip`: `/etc/x` | 237 B | `invalid_name` ("absolute path") | 0 |
| `backslash.zip`: `a\b` | 231 B | `invalid_name` ("invalid characters", from `strictFileNames`) | 0 |
| `duplicate.zip`: `manifest.json` twice | 270 B | `duplicate_name` | 0 |
| `understated.zip`: 10 MiB declared as 1,000 bytes, in both headers | 10 KB | `entry_invalid` (yauzl: "too many bytes in the stream. expected 1000. got at least 16384") | 16 KiB, stopped by yauzl before the spike's counter |
| `truncated.zip`: a valid archive cut in half | 33 KB | `archive_invalid` ("End of central directory record signature not found") | 0 |
| `zip64.zip`: ZIP64 extra fields on a small entry | 283 B | **opens** (it's legitimate) | |
| `ok.zip` | 4.5 KB | **opens** | |
| both Homebox fixtures (H1) | 22 KB, 139 KB | **open**; every entry read (34 KB and 190 KB inflated) | |

T7's reason names differ slightly from the spike's (`bad_name`, `truncated`, `too_large`); T7's
are the contract. The spike's `entry_invalid` for an understated header is the one T7 needs to
add, or map to `ratio`/`truncated`.

## The writer

`z1_write.mjs`: yazl `ZipFile`, entries of 3,158,073 bytes each (a phone photo's size, not
block-aligned) added with `addReadStreamLazy(name, {compress: false, size, mtime}, cb)`, the
bytes generated on the fly (JPEG magic, then a repeated random 64 KiB pattern), and a stored
`manifest.json` from `addBuffer(…, {compress: false})`. Run with `--max-old-space-size=256`.

| Total | Entries | Written | Peak RSS | Time | Predicted size |
|---|---|---|---|---|---|
| 2 GiB, to a counting sink | 681 | 2,147,588,410 B | **29 MiB** | 6.6 s | exact |
| 4.1 GiB (ZIP64 by size), to a counting sink | 1,396 | 4,405,715,646 B | **41 MiB** | 15.8 s | (not predicted in that run) |
| 300 MiB, to a file | 101 | 315,821,970 B | 21 MiB | 1.7 s | exact |

- **The size is known before writing.** With `compress: false` and `size` on every entry,
  `end()`'s `calculatedTotalSizeCallback` gives the archive's exact size (2,147,588,410 predicted,
  2,147,588,410 written). With a deflated entry it gives `-1`. So an export whose JSON is added
  deflated can't announce its size up front; T12 records the size after writing (it does, from
  the temp file), and nothing needs the prediction.
- yazl sets general-purpose bit 3 (a data descriptor) on streamed entries, as Homebox's Go writer
  does. Its README notes that Archive Utility needs *no* data descriptor when bit 3 isn't set,
  and yazl follows that.
- **The 300 MiB archive** passes `unzip -t` ("No errors detected"), lists 101 entries with
  `bsdtar -tf`, and reads back through yauzl with every byte (315,807,337 inflated = the sum of
  the entries).
- **Not run: a 2 GB archive on disk.** The disk had 0.7–2.9 GB free during the run, shared with
  other agents. The 2 GiB and 4.1 GiB streams went to a counting sink, so no reader has checked
  offsets past 2 GiB yet. T7's test writes one to a temp file and reads it back; whether macOS
  Archive Utility opens a 2 GB export goes on the device checklist.

## For T7

- `blob-reader.ts`: the spike's `BlobRangeReader`, with its block cache (1 MiB × 16) and the
  PassThrough bridge. Test that a 200,001-entry archive costs at most ~15 GETs on S3 (count the
  store's calls).
- `limits.ts`: add `ratioFloorBytes: 1 << 20` beside the 100 : 1 ratio.
- `read.ts`: check the declared ratio and total before inflating, then count real bytes while
  streaming; keep `validateEntrySizes` and `strictFileNames` on.
- `write.ts`: as planned. Photos, PDFs and other already-compressed files stored, JSON, CSV and
  HTML deflated.
