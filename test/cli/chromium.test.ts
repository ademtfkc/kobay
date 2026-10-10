import { expect, it } from 'vitest';
import { projectCreate, explore } from '../../src/cli/komutlar/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/** KOBAY_TEST_STRICT=1 verildiğinde atlama yasak: eksik ortam hata sayılır. */
const kati = process.env.KOBAY_TEST_STRICT === '1';

it('gerçek Chromium ile demo uygulamasını keşfeder', async (context) => {
  if (process.env.KOBAY_CHROMIUM_TEST !== '1') {
    if (kati) {
      throw new Error('KOBAY_TEST_STRICT=1: bu test atlanamaz, KOBAY_CHROMIUM_TEST=1 verilmeli');
    }
    context.skip();
    return;
  }
  const { baslat } = await import('../kobay-demo/sunucu.mjs') as {
    baslat: (port: number) => Promise<{ url: string; kapat: () => Promise<void> }>;
  };
  const sunucu = await baslat(0);
  try {
    const cwd = await geciciDizinAc('kobay-cli-chromium-');
    await projectCreate({
      cwd,
      url: sunucu.url,
      login: { username: 'demo', password: 'demo123' },
      loginUrl: `${sunucu.url}/login`,
      beyin: { adaptor: 'sahte' },
    });
    const sonuc = await explore({ cwd });
    expect(sonuc.exitCode).toBe(0);
    expect((sonuc.json as { pages: unknown[] }).pages.length).toBeGreaterThan(0);
  } finally {
    await sunucu.kapat();
  }
});
