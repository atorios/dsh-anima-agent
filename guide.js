import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUIDE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'guide.md');

export function readGuide() {
  try {
    return readFileSync(GUIDE_PATH, 'utf8').trim();
  } catch (error) {
    return `guide.md could not be read (${error.message}). It should sit next to this plugin's index.js.`;
  }
}
