import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const dir = dirname(fileURLToPath(import.meta.url));
const file = join(dir, '../src-tauri/build_number.txt');
const conf = JSON.parse(readFileSync(join(dir, '../src-tauri/tauri.conf.json'), 'utf8'));
const version = conf.version ?? '1.0.0';

let n = 1;
try { n = parseInt(readFileSync(file, 'utf8').trim(), 10) + 1; } catch {}
if (isNaN(n) || n < 1) n = 1;

writeFileSync(file, String(n) + '\n');
console.log(`Build ${version}.${n}`);
