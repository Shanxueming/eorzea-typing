import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** apps/server/src -> 仓库根目录 */
export const REPO_ROOT = path.resolve(here, '..', '..', '..');
export const WORDBANKS_DIR = path.join(REPO_ROOT, 'data', 'wordbanks');
export const ASSETS_DIR = path.join(REPO_ROOT, 'assets');
export const WEB_DIST_DIR = path.join(REPO_ROOT, 'apps', 'web', 'dist');
