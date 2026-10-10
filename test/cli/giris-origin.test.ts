import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Harita } from '../../src/depo/index.js';

const sahteler = vi.hoisted(() => ({ hata: undefined as unknown }));

vi.mock('../../src/kesif/index.js', async (asilModul) => ({
  ...(await asilModul<typeof import('../../src/kesif/index.js')>()),
  kesfet: vi.fn(async () => { throw sahteler.hata; }),
  sayfayiYenile: vi.fn(async () => { throw sahteler.hata; }),
}));

vi.mock('../../src/kos/index.js', () => ({
  hedefAyaktaMi: vi.fn(async () => true),
  kostur: vi.fn(async () => { throw new Error('Bu testte koşu olmamalı'); }),
}));

import { explore, testRefresh } from '../../src/cli/komutlar/index.js';
import { KobayDizini, type TestKaydi } from '../../src/depo/index.js';
import { CredentialLeakBlockedError, CredentialOriginError, LoginFormOriginError } from '../../src/kesif/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

const TEST_ID = 't_abc12345';
const harita: Harita = {
  baseUrl: 'http://uygulama.test',
  loggedIn: true,
  exploredAt: '2026-09-17T00:00:00.000Z',
  pages: [{ url: 'http://uygulama.test/cariler', title: 'Cariler', headings: [], links: [], forms: [], buttons: [], menu: [] }],
};
const testKaydi: TestKaydi = {
  id: TEST_ID,
  name: 'Cariler',
  type: 'frontend',
  createdFrom: 'plan',
  status: 'failed',
  planSteps: [{ type: 'action', description: 'Cariler sayfasını aç' }],
  priority: 'p0',
  url: '/cariler',
  codeVersion: 1,
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
};

async function proje(): Promise<string> {
  const cwd = await geciciDizinAc('kobay-giris-origin-');
  const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
  await dizin.haritaYaz(harita);
  await dizin.testYaz(testKaydi);
  return cwd;
}

afterEach(() => { sahteler.hata = undefined; });

const girisHatalari: Array<[string, () => Error]> = [
  ['CredentialLeakBlockedError', () => new CredentialLeakBlockedError(
    'The login page tried to send the credentials to a different origin (http://kotu.test); the password was not sent.',
  )],
  ['LoginFormOriginError', () => new LoginFormOriginError(
    'The login form is on a different origin (http://kotu.test); credentials are only sent to http://uygulama.test.',
  )],
  ['CredentialOriginError', () => new CredentialOriginError('The saved credentials belong to another address.')],
];

describe('giriş origin hataları', () => {
  it.each(girisHatalari)('%s: explore ve test refresh exit 5 (yetki) verir, mesaj korunur', async (_ad, uret) => {
    const cwd = await proje();
    sahteler.hata = uret();

    const kesif = await explore({ cwd });
    expect(kesif.exitCode).toBe(5);
    expect(kesif.json).toEqual({ error: expect.objectContaining({ code: 'PermissionError' }) });
    expect(kesif.mesaj).toContain((sahteler.hata as Error).message);

    const yenileme = await testRefresh({ cwd, id: TEST_ID, run: false });
    expect(yenileme.exitCode).toBe(5);
    expect(yenileme.mesaj).toContain((sahteler.hata as Error).message);
  });

  it('aynı mesajla gelen tipsiz Error yetki hatasına çevrilmez (eşleme sınıfla, mesajla değil)', async () => {
    const cwd = await proje();
    sahteler.hata = new Error(
      'The login form is on a different origin (http://kotu.test); credentials are only sent to http://uygulama.test.',
    );

    const kesif = await explore({ cwd });
    expect(kesif.exitCode).toBe(4);
  });

  it('ilgisiz motor hatası yetki hatasına çevrilmez', async () => {
    const cwd = await proje();
    sahteler.hata = new Error('Browser crashed');

    const kesif = await explore({ cwd });
    expect(kesif.exitCode).toBe(4);
  });
});
