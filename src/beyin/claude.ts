import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BeyinAyari } from '../depo/index.js';
import { BeyinCalismaHatasi, BeyinHatasi, type Beyin, type BeyinIstegi, type BeyinYaniti } from './index.js';
import {
  beyinGunluguYaz,
  type BeyinButcesi,
  type BeyinKullanimi,
  cliCikisHatasi,
  gizliDegerleriMaskele,
  insanOnayiNotu,
  komutSonucu,
  type KomutSonucu,
  semaylaSor,
  istemOlustur,
  surecBaslamadiMi,
} from './ortak.js';

let anthropicApiAnahtariUyarildi = false;

function sayiOku(deger: unknown): number | undefined {
  return typeof deger === 'number' && Number.isFinite(deger) && deger >= 0 ? deger : undefined;
}

/** `claude -p --output-format json` tek sonuç nesnesi (type: "result"). */
interface ClaudeSonucu {
  type?: unknown;
  subtype?: unknown;
  result?: unknown;
  total_cost_usd?: unknown;
  num_turns?: unknown;
  is_error?: unknown;
}

function claudeSonucuOku(stdout: string): ClaudeSonucu | undefined {
  try {
    const ayrisilmis = JSON.parse(stdout) as unknown;
    return typeof ayrisilmis === 'object' && ayrisilmis !== null && !Array.isArray(ayrisilmis)
      ? ayrisilmis as ClaudeSonucu
      : undefined;
  } catch {
    return undefined;
  }
}

/** Claude CLI'nin bütçe aşımı alt türü (claude 2.1.x: error_max_budget_usd). */
const BUTCE_ASIMI_ALT_TURU = 'error_max_budget_usd';
const BUTCE_METNI_DESENI = /(?:max(?:imum)?[-_ ]?budget|budget|cost limit|spend limit|maliyet|bütçe)/i;

export class ClaudeBeyni implements Beyin {
  readonly ad = 'claude';

  constructor(
    private readonly ayar: BeyinAyari,
    private readonly env: NodeJS.ProcessEnv,
    private readonly butce: BeyinButcesi,
  ) {}

  async sor<T>(istek: BeyinIstegi): Promise<BeyinYaniti<T>> {
    const baslangic = Date.now();
    const geciciDizin = await mkdtemp(join(tmpdir(), 'kobay-claude-'));
    let sonIstem = istemOlustur(istek);
    let sonHam = '';
    let sonKullanim: BeyinKullanimi | undefined;
    try {
      const sonuc = await semaylaSor<T>(istek, async (istem) => {
        sonIstem = istem;
        if (!anthropicApiAnahtariUyarildi && this.env.ANTHROPIC_API_KEY !== undefined && this.env.ANTHROPIC_API_KEY !== '') {
          process.stderr.write('[kobay] Uyarı: ANTHROPIC_API_KEY tanımlı; claude -p çağrıları API hesabınıza faturalanabilir.\n');
          anthropicApiAnahtariUyarildi = true;
        }
        const rezervasyon = this.butce.claudeCagrisiBaslat();
        const argumanlar = [
          '-p', '--output-format', 'json', '--safe-mode', '--tools', '',
          '--setting-sources', 'local', '--strict-mcp-config', '--no-session-persistence',
          '--max-budget-usd', String(rezervasyon.azamiMaliyetUsd),
        ];
        if (this.ayar.model !== undefined) argumanlar.push('--model', this.ayar.model);
        let calisma: KomutSonucu;
        try {
          calisma = await komutSonucu('claude', argumanlar, {
            girdi: istem,
            env: this.env,
            cwd: geciciDizin,
            ...(istek.zamanAsimiSn === undefined ? {} : { zamanAsimiSn: istek.zamanAsimiSn }),
          });
        } catch (hata) {
          // Yalnız süreç hiç başlamadıysa iade; başladıysa faturalanmış olabilir.
          if (surecBaslamadiMi(hata)) this.butce.cagriIptal(rezervasyon);
          else this.butce.cagriHarcandi(rezervasyon);
          throw hata;
        }
        const disYanit = claudeSonucuOku(calisma.stdout);
        sonHam = typeof disYanit?.result === 'string' ? disYanit.result : '';
        const maliyetUsd = sayiOku(disYanit?.total_cost_usd);
        const turSayisi = sayiOku(disYanit?.num_turns);
        const altTur = typeof disYanit?.subtype === 'string' ? disYanit.subtype : undefined;
        sonKullanim = {
          ...(maliyetUsd === undefined ? {} : { maliyetUsd }),
          ...(turSayisi === undefined ? {} : { turSayisi }),
          ...(typeof disYanit?.is_error === 'boolean' ? { hataMi: disYanit.is_error } : {}),
        };

        const basarisiz = calisma.zamanAsimi
          || calisma.kod !== 0
          || disYanit === undefined
          || disYanit.is_error === true
          || (altTur !== undefined && altTur !== 'success');
        if (!basarisiz) {
          this.butce.cagriTamamla(rezervasyon, maliyetUsd);
          return { ham: sonHam, ...sonKullanim };
        }

        // Başlamış ve başarısız çağrı: rezervasyon iade edilmez; JSON'da gerçek maliyet varsa onunla uzlaşılır.
        this.butce.cagriHarcandi(rezervasyon, maliyetUsd);
        const butceAsimi = altTur === undefined
          ? disYanit?.is_error === true && BUTCE_METNI_DESENI.test(sonHam)
          : altTur === BUTCE_ASIMI_ALT_TURU;
        if (butceAsimi) {
          throw new BeyinCalismaHatasi(
            'maliyet_tavani',
            `Claude çağrı başı maliyet tavanına (${rezervasyon.azamiMaliyetUsd} USD) ulaşıldı. `
              + insanOnayiNotu('KOBAY_MAX_BUDGET_USD veya beyin.maxBudgetUsd'),
          );
        }
        if (calisma.zamanAsimi) throw new BeyinHatasi('zaman_asimi');
        if (calisma.kod !== 0) throw cliCikisHatasi(calisma.kod, calisma.stderr);
        if (disYanit === undefined) {
          throw new BeyinCalismaHatasi('cli_hatasi', 'Claude çıktısı JSON olarak ayrıştırılamadı.');
        }
        throw new BeyinCalismaHatasi(
          'cli_hatasi',
          `Claude hata yanıtı verdi${altTur === undefined ? '' : ` (${altTur})`}: `
            + gizliDegerleriMaskele(sonHam).slice(0, 500),
        );
      });
      await beyinGunluguYaz(istek.logDizini, istek.gorev, sonIstem, sonuc.ham, sonuc);
      return { ...sonuc, sureMs: Date.now() - baslangic, adaptor: this.ad };
    } catch (hata) {
      const gunlukHam = hata instanceof BeyinCalismaHatasi && hata.detay !== undefined ? hata.detay : sonHam;
      await beyinGunluguYaz(istek.logDizini, istek.gorev, sonIstem, gunlukHam, sonKullanim);
      throw hata;
    } finally {
      await rm(geciciDizin, { recursive: true, force: true });
    }
  }
}
