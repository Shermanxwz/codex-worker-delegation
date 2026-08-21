import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_IGNORES = new Set(['.git', 'node_modules', '.DS_Store']);

async function walk(root, dir = root, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a,b)=>a.name.localeCompare(b.name,'en'));
  for (const entry of entries) {
    if (DEFAULT_IGNORES.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isDirectory()) await walk(root, absolute, out);
    else if (entry.isFile()) out.push({ absolute, relative });
    else if (entry.isSymbolicLink()) {
      const target = await fs.readlink(absolute);
      out.push({ absolute, relative, symlink: target });
    } else throw new Error(`unsupported filesystem entry in digest: ${relative}`);
  }
  return out;
}

export async function treeDigest(root, { transform } = {}) {
  const absoluteRoot = path.resolve(root);
  const stat = await fs.stat(absoluteRoot);
  if (!stat.isDirectory()) throw new Error(`tree digest root is not a directory: ${absoluteRoot}`);
  const digest = crypto.createHash('sha256');
  const files = await walk(absoluteRoot);
  for (const entry of files) {
    if (entry.symlink !== undefined) {
      digest.update(`l\0${entry.relative}\0${entry.symlink}\n`);
      continue;
    }
    const statEntry = await fs.stat(entry.absolute);
    let bytes = await fs.readFile(entry.absolute);
    if (transform) bytes = Buffer.from(await transform(entry.relative, bytes));
    const contentSha = crypto.createHash('sha256').update(bytes).digest('hex');
    const executable = (statEntry.mode & 0o111) ? 'x' : '-';
    digest.update(`f${executable}\0${entry.relative}\0${contentSha}\n`);
  }
  return { sha256: digest.digest('hex'), files: files.length, root: absoluteRoot };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) { console.error('usage: node scripts/tree-digest.mjs <directory> [--json]'); process.exit(2); }
  const result = await treeDigest(root);
  if (process.argv.includes('--json')) console.log(JSON.stringify(result)); else console.log(result.sha256);
}
