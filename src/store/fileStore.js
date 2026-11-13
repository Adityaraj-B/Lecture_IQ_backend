import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Local development store: the whole working set in one JSON file, swapped in atomically. */
export function fileStore(file) {
  return {
    kind: 'file',
    async load() {
      try {
        return JSON.parse(await readFile(file, 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return {};
        throw err;
      }
    },
    async write(data) {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(data));
      await rename(tmp, file);
    },
  };
}
