import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const dir = dirname(fileURLToPath(import.meta.url));
const file = join(dir, '../src-tauri/build_number.txt');

let n = 1;
try { n = parseInt(readFileSync(file, 'utf8').trim(), 10) + 1; } catch {}
if (isNaN(n) || n < 1) n = 1;

writeFileSync(file, String(n) + '\n');
console.log(`Build #${String(n).padStart(6, '0')}`);
