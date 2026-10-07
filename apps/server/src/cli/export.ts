import { loadBackupCliEnv } from '../backup/config.js';
import { runExport } from '../backup/export.js';

// `kept admin export --out <dir>` (T31c, D207): every row and every file, raw, secrets sealed
// (backup/export.ts). The escape hatch until the readable export (step 7).

type Source = Record<string, string | undefined>;

export async function exportCommand(
  source: Source,
  outDir: string,
  print: (line: string) => void,
): Promise<number> {
  const env = await loadBackupCliEnv(source);
  const report = await runExport({ ownerUrl: env.ownerUrl, outDir, blobs: env.blobs, print });
  print(`Exported to ${report.outDir}. Secret values are sealed: the recovery kit opens them.`);
  return report.missing.length > 0 ? 1 : 0;
}
