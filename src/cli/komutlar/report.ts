import { lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { yazAtomik } from '../../depo/index.js';
import {
  ReportInputError, UnsafeReportPath, VARSAYILAN_ISTEM_SAYISI, raporTestleriniSec, raporUret, terminaleGuvenli,
} from '../../rapor/index.js';
import { uyariYaz } from '../cikti.js';
import { UsageError, basariliMetin, komutCalistir, type KomutSonucu } from '../komut.js';
import { RAPOR_DIZINI, dizinBul, raporYoluDenetle } from './ortak.js';

const require = createRequire(import.meta.url);
const { version: KOBAY_SURUMU } = require('../../../package.json') as { version: string };

function cogul(sayi: number, birim: string): string {
  return `${sayi} ${birim}${sayi === 1 ? '' : 's'}`;
}

/**
 * `--summary` dosyası: `--out` ile aynı kural ailesi (kök dışı serbest; `.git/`,
 * `.claude/`, `.kobay/` gibi gizli bileşenler yasak). `.kobay/report` istisnası
 * burada YOK: rapor klasörü yalnız beklenen girdileri taşıyabilir, içine yazılan
 * özet bir sonraki raporu reddettirirdi. Aynı sebeple özet, `--out` ile verilen
 * rapor klasörünün içine de yazılamaz. Var olan dizin hedefi reddedilir.
 */
async function ozetYoluDenetle(projeKoku: string, ozet: string, raporHedefi: string): Promise<void> {
  const fark = relative(raporHedefi, ozet);
  if (fark === '' || (fark !== '..' && !fark.startsWith(`..${sep}`) && !isAbsolute(fark))) {
    throw new UsageError(`--summary cannot be inside the report directory: ${ozet}`);
  }
  await raporYoluDenetle(projeKoku, ozet, '--summary');
  const durum = await lstat(ozet).catch(() => null);
  if (durum?.isDirectory() === true) throw new UsageError(`--summary must be a file path, not a directory: ${ozet}`);
}

/**
 * `kobay test report`: seçilen testlerin son koşularından statik HTML rapor
 * üretir. Testlerin düşmüş olması çıkış kodunu etkilemez (rapor üretildi: 0).
 * `summary` verilirse aynı veriden PR'a hazır Markdown özet de yazılır.
 */
export async function testReport(a: {
  cwd: string;
  ids?: string[];
  all?: boolean;
  out?: string;
  summary?: string;
  maxPrompts?: number;
}): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    if (a.maxPrompts !== undefined && a.summary === undefined) {
      throw new UsageError('--max-prompts only applies together with --summary <path>');
    }
    if (a.all === true && a.ids !== undefined && a.ids.length > 0) {
      throw new UsageError('--all cannot be combined with test IDs; either pass IDs or use --all');
    }
    if (a.all !== true && (a.ids === undefined || a.ids.length === 0)) {
      throw new UsageError('At least one test ID or --all is required; list the IDs with `kobay test list`');
    }
    const dizin = await dizinBul(a.cwd);
    const varsayilanHedef = resolve(dizin.projeKoku, ...RAPOR_DIZINI);
    const hedef = a.out === undefined ? varsayilanHedef : (isAbsolute(a.out) ? resolve(a.out) : resolve(a.cwd, a.out));
    // Rapor maskesiz ekran görüntüsü taşır: .git/, .claude/, .kobay/ altı yasak, tek istisna .kobay/report.
    await raporYoluDenetle(dizin.projeKoku, hedef, '--out');
    const ozetHedefi = a.summary === undefined
      ? undefined
      : (isAbsolute(a.summary) ? resolve(a.summary) : resolve(a.cwd, a.summary));
    // Yol reddi rapor yazılmadan önce: kullanım hatası (2) hiçbir dosyaya dokunmaz.
    if (ozetHedefi !== undefined) await ozetYoluDenetle(dizin.projeKoku, ozetHedefi, hedef);

    let sonuc;
    try {
      // Kayıtlar symlink izlenmeden okunur (rapor CI artifact'ine gidebilir).
      const testler = await raporTestleriniSec(dizin, a.all === true ? undefined : a.ids);
      sonuc = await raporUret({
        dizin,
        testler,
        hedef,
        surum: KOBAY_SURUMU,
        varsayilanHedef: hedef === varsayilanHedef,
        ...(ozetHedefi === undefined ? {} : { ozet: { maxIstem: a.maxPrompts ?? VARSAYILAN_ISTEM_SAYISI } }),
      });
    } catch (hata: unknown) {
      if (hata instanceof UnsafeReportPath || hata instanceof ReportInputError) throw new UsageError(hata.message);
      throw hata;
    }
    if (ozetHedefi !== undefined) {
      // Atomik yazım: yarım özet dosyası PR yorumuna gitmesin.
      await yazAtomik(ozetHedefi, sonuc.summaryMarkdown ?? '');
    }
    for (const yol of sonuc.keptAside) {
      uyariYaz(
        `[kobay] Warning: a folder set aside while publishing the report is not a kobay report, so it was kept: ${terminaleGuvenli(yol)}\n`,
      );
    }

    const veri = {
      reportDir: sonuc.reportDir,
      indexPath: sonuc.indexPath,
      tests: sonuc.tests,
      counts: sonuc.counts,
      screenshots: sonuc.screenshots,
      // Yalnız bir şey yerinde bırakıldıysa: kullanıcı yolu bilsin.
      ...(sonuc.keptAside.length === 0 ? {} : { keptAside: sonuc.keptAside }),
      // Ajan istemleri: yalnız düşen/engellenen/sonuçsuz test varsa (CI bunları PR yorumunda kullanabilir).
      ...(sonuc.fixPrompts.length === 0 ? {} : { fixPrompts: sonuc.fixPrompts }),
      ...(sonuc.fixAllPrompt === undefined ? {} : { fixAllPrompt: sonuc.fixAllPrompt }),
      ...(ozetHedefi === undefined ? {} : { summaryPath: ozetHedefi }),
    };
    const c = sonuc.counts;
    const metin = [
      `Report written: ${cogul(sonuc.tests.length, 'test')} (${c.passed} passed, ${c.failed} failed,`
      + ` ${c.blocked} blocked, ${c.inconclusive} inconclusive, ${c.notRun} not run),`
      + ` ${cogul(sonuc.screenshots, 'screenshot')}.`,
      // Yol kullanıcının --out'undan gelir; insan çıktısında kontrol karakteri ham basılmaz (JSON zarfı aynı kalır).
      `Open: ${terminaleGuvenli(sonuc.indexPath)}`,
      ...(ozetHedefi === undefined ? [] : [`Summary written: ${terminaleGuvenli(ozetHedefi)}`]),
      ...(sonuc.screenshots === 0 ? [] : ['Screenshots are not redacted; review them before sharing the report.']),
    ].join('\n');
    return basariliMetin(veri, metin);
  });
}
