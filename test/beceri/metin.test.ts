import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { beceriKur, beceriMetni } from '../../src/beceri/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/** Satır kırılımı cümleyi bölebilir; kıyas tek boşluğa indirgenmiş metinle yapılır. */
function duz(metin: string): string {
  return metin.replace(/\s+/g, ' ');
}

describe('beceri metni', () => {
  it('MCP sonucunda geçti/düştü kararını verdict\'e bağlar, isError\'ı yalnız araç hatası sayar', async () => {
    const proje = await geciciDizinAc('kobay-beceri-metin-');
    const cursor = await readFile((await beceriKur('cursor', { projeKoku: proje })).path, 'utf8');
    for (const metin of [beceriMetni(), cursor].map(duz)) {
      expect(metin).toContain('Decide pass or fail from `verdict` in that JSON, never from `isError`');
      expect(metin).toContain('a failed test (exit `1`) comes back without `isError`, with `"verdict": "failed"`');
      expect(metin).toContain('`isError: true` only means the tool could not do its job (exit `2`–`5`');
      // blocked (3) / inconclusive (4) isError ile ama verdict'li dizi olarak gelir; ajan dizide verdict okur.
      expect(metin).toContain('if it is `{"error": {"code": ..., "message": ...}}`, it is a usage or engine error');
      expect(metin).toContain('`test_run` and `test_rerun` can also return `isError: true` with the usual array of result rows: read each row\'s `verdict` anyway');
      expect(metin).toContain('`blocked` (exit `3`) and `inconclusive` (exit `4`) come back this way');
      expect(metin).not.toContain('the text is then `{"error"');
      // Eski, yanlış kural: ajan düşen testi `isError` yok diye geçti sayardı.
      expect(metin).not.toContain('a failed test counts');
      expect(metin).not.toMatch(/isError: true` means a non-zero exit/);
    }
  });

  it('npx yedeği kapsamlı paket adını verir, registry\'de olmayan çıplak `kobay`ı değil', () => {
    const metin = duz(beceriMetni());
    expect(metin).toContain('`npx -y @ademtfkc/kobay`');
    expect(metin).not.toMatch(/npx (-y )?kobay\b/);
  });

  it('Claude izinli araçları kobay komutunu ve npx yedeğini kapsar', async () => {
    const proje = await geciciDizinAc('kobay-beceri-izin-');
    const kurulu = await readFile((await beceriKur('claude', { projeKoku: proje })).path, 'utf8');
    const satir = /^allowed-tools: (.*)$/m.exec(kurulu.split('\n---')[0] ?? '')?.[1];
    expect(satir?.split(', ')).toEqual(['Bash(kobay *)', 'Bash(npx -y @ademtfkc/kobay *)']);
  });
});
