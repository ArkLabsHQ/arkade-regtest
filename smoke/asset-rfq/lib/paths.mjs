import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = join(ROOT, 'data');
export const KEYS_PATH = join(DATA, 'keys.json');
export const STATE_PATH = join(DATA, 'state.json');
export const SOLVER_ENV_PATH = join(DATA, 'solver.env');
export const SWAPS_DIR = join(DATA, 'swaps');

mkdirSync(DATA, { recursive: true });
mkdirSync(SWAPS_DIR, { recursive: true });
