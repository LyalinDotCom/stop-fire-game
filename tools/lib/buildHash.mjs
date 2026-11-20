// Deterministic 12-hex SHA-1 build identity injected via vite.config.js (__BUILD_HASH__).
// Two browsers share a Mega-Basin shard only when their simulation/netcode build hash matches.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FILES = ['index.html', 'package.json', 'vite.config.js'];
const TREES = [['src', () => true]];

function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function walk(root, dir, keep, out = []) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return out;
  const entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => compareCodeUnits(a.name, b.name));
  for (const entry of entries) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, rel, keep, out);
    } else if (entry.isFile() && keep(rel)) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Computes a deterministic 12-lowercase-hex SHA-1 digest over `src/`, `index.html`,
 * `package.json`, and `vite.config.js`.
 */
export function buildHash(root) {
  const hash = createHash('sha1');
  const files = [
    ...FILES.filter((f) => fs.existsSync(path.join(root, f))).sort(compareCodeUnits),
    ...TREES.flatMap(([dir, keep]) => walk(root, dir, keep)),
  ];
  for (const f of files) {
    const norm = f.split(path.sep).join('/');
    hash.update(`${norm}\0`).update(fs.readFileSync(path.join(root, f))).update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}
