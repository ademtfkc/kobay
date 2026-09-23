import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { yazAtomik } from '../depo/index.js';
import { fixtureSablonu } from './fixture-sablonu.js';

/** Üretilen testlerin yükleyeceği fixture modülü bulunamadığında atılır. */
export class FixtureModuleMissing extends Error {
  constructor(paketKoku: string) {
    super(
      `Kobay fixture module not found (${paketKoku}). The package is missing or only partly built; `
      + 'run `npm run build` in the kobay source, or reinstall kobay.',
    );
    this.name = 'FixtureModuleMissing';
  }
}

/** Şu an çalışan kobay kurulumunun kökü: npm link, -g kurulum ya da kaynak ağaç. */
const AKTIF_PAKET_KOKU = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Önce derlenmiş modül; yoksa kaynaktan çalışan geliştirme kurulumu. */
const FIXTURE_ADAYLARI = [join('dist', 'kos', 'fixture.js'), join('src', 'kos', 'fixture.ts')];

function kaliciConfigMetni(): string {
  return [
    'export default {',
    "  testDir: 'tests',",
    '  timeout: Number(process.env.KOBAY_TEST_ZAMAN_ASIMI_MS ?? 120000),',
    '  workers: 1,',
    '  retries: 0,',
    "  reporter: [['json', { outputFile: process.env.KOBAY_RAPOR_DOSYASI }]],",
    "  use: { baseURL: process.env.KOBAY_BASE_URL, trace: 'on', screenshot: 'only-on-failure', video: 'off' },",
    "  outputDir: `${process.env.KOBAY_KOSU_DIZINI}/pw`,",
    '};',
    '',
  ].join('\n');
}

async function dosyaVarMi(yol: string): Promise<boolean> {
  try {
    await access(yol);
    return true;
  } catch {
    return false;
  }
}

async function farkliysaYaz(yol: string, icerik: string): Promise<void> {
  try {
    if (await readFile(yol, 'utf8') === icerik) return;
  } catch (hata: unknown) {
    if (!(typeof hata === 'object' && hata !== null && 'code' in hata && hata.code === 'ENOENT')) throw hata;
  }
  await yazAtomik(yol, icerik);
}

/**
 * `.kobay/tests/_fixture.ts` içeriğini **çalışan** kobay kurulumuna göre üretir.
 *
 * Yol bir kere yazılıp bırakılamaz: kurulum değişince (npm link → npm install -g, sürüm
 * yükseltme) eski paketin fixture'ı ayrı bir @playwright/test kopyası yükler, Playwright
 * hiç test koşturamaz. Hedef modül yoksa `FixtureModuleMissing` atılır.
 */
export async function fixtureYenidenAktarimMetni(paketKoku: string = AKTIF_PAKET_KOKU): Promise<string> {
  for (const aday of FIXTURE_ADAYLARI) {
    const yol = join(paketKoku, aday);
    if (await dosyaVarMi(yol)) return fixtureSablonu(yol);
  }
  throw new FixtureModuleMissing(paketKoku);
}

/**
 * Koşuların paylaştığı kalıcı Playwright yapılandırmasını hazırlar.
 * `_fixture.ts` her koşudan önce tazelenir; içerik aynıysa dosyaya dokunulmaz.
 */
export async function kaliciCalismaAlaniHazirla(
  kobayKoku: string,
  paketKoku: string = AKTIF_PAKET_KOKU,
): Promise<{ configYolu: string; fixtureYolu: string }> {
  const configYolu = join(kobayKoku, 'playwright.config.ts');
  const fixtureYolu = join(kobayKoku, 'tests', '_fixture.ts');
  // Fixture modülü yoksa burada patlar; koşu tarayıcı açmadan inconclusive olur.
  const fixtureMetni = await fixtureYenidenAktarimMetni(paketKoku);
  await Promise.all([
    farkliysaYaz(configYolu, kaliciConfigMetni()),
    farkliysaYaz(fixtureYolu, fixtureMetni),
  ]);
  return { configYolu, fixtureYolu };
}
