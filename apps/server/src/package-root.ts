import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The directory holding the nearest package.json above `fromUrl` (a module's import.meta.url).
 * Files that ship beside the code (migrations/) are found from here rather than by counting
 * `../` from the calling file, which differs between src/ (tsx) and dist/ (built).
 */
export function packageRoot(fromUrl: string = import.meta.url): string {
  let dir = path.dirname(fileURLToPath(fromUrl));
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no package.json above ${fileURLToPath(fromUrl)}`);
    dir = parent;
  }
}
