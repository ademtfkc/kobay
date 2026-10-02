import { mkdtemp } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kanitDosyaAdi } from '../src/analiz/index.js';
import { playwrightSpecArgumani as kosSpecArgumani } from '../src/kos/index.js';
import { mcpGercekYol } from '../src/mcp/index.js';
import { playwrightSpecArgumani as uretSpecArgumani } from '../src/uret/index.js';

describe('Windows platform enjeksiyonu', () => {
  it('koşu ve üretim Playwright filtrelerini göreli ve slash ayracılı verir', () => {
    const cwd = 'C:\\Users\\Gokhan\\Proje\\.kobay';
    const spec = win32.join(cwd, 'tests', 't_x.spec.ts');
    const yol = { relative: win32.relative, sep: win32.sep };

    for (const arguman of [kosSpecArgumani(spec, cwd, yol), uretSpecArgumani(spec, cwd, yol)]) {
      expect(arguman).toBe('tests/t_x.spec.ts');
      expect(arguman).not.toContain('\\');
      expect(new RegExp(arguman).test(win32.relative(cwd, spec).replaceAll('\\', '/'))).toBe(true);
    }
  });

  it('Windows kanıt kaynağından çıplak dosya adını alır', () => {
    const kaynak = win32.join('C:\\Users\\Gokhan\\Proje', '.kobay', 'runs', 'step-1.png');
    expect(kanitDosyaAdi(kaynak, win32)).toBe('step-1.png');
  });

  it('MCP gerçek yolunu native realpath ile tek kaynaktan kanonikleştirir', async () => {
    const dizin = await mkdtemp(join(tmpdir(), 'kobay-mcp-realpath-'));
    expect(mcpGercekYol(dizin)).toBe(realpathSync.native(dizin));
  });
});
