import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('iskelet', () => {
  it('package.json ESM ve kobay bin tanımlı', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.type).toBe('module');
    expect(pkg.bin.kobay).toBe('dist/cli/index.js');
  });
});
