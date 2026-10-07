import { HomeboxChoices } from '@kept/shared';
import { invalid } from '../../http/errors.js';
import { importArchiveKey } from '../../storage/blob-store.js';
import type { ArchiveImporter } from '../archive-types.js';
import { inspectHomebox } from './inspect.js';
import { loadHomeboxLookups } from './lookups.js';
import { planHomebox } from './plan.js';
import { type HomeboxData, openHomebox, readHomebox } from './read.js';

// The Homebox export's importer (D146; step-7 plan T8, T9, T10), as imports/archive.ts dispatches
// to it for a `homebox_zip` run: inspect reads the manifest and counts, the dry run plans the
// whole archive against the target and writes nothing but the report (only rows with issues,
// Q27), and the job is `import-homebox` (job.ts).

/** Files the target takes when the run's request has no storage (it then can't import). */
const NO_STORAGE_MAX = 25 * 1024 * 1024;

export const homeboxImporter: ArchiveImporter<HomeboxData> = {
  job: 'import-homebox',
  open: (files, run) =>
    openHomebox(files.blobs, importArchiveKey(run.id), Number(run.archive_bytes ?? 0)),
  inspect: async (archive, run) => inspectHomebox(await readHomebox(archive), run.source_version),
  load: (archive) => readHomebox(archive),
  dryRun: async (c, run, data) => {
    const choices = HomeboxChoices.safeParse(run.choices);
    if (!choices.success) throw invalid('Make the choices first.');
    const lookups = await loadHomeboxLookups(
      c.tx,
      c.client,
      c.scope,
      run.location_id,
      data,
      choices.data,
      c.files?.maxFileBytes ?? NO_STORAGE_MAX,
    );
    const plan = planHomebox(data, choices.data, lookups);
    return { report: plan.report, total: plan.ops.length };
  },
};
