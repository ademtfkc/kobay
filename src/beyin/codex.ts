import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BeyinAyari } from '../depo/index.js';
import { BrainError, BrainRuntimeError, type Beyin, type BeyinIstegi, type BeyinYaniti } from './index.js';
import {
  beyinGunluguYaz,
  type BeyinButcesi,
  gizliDegerleriMaskele,
  komutSonucu,
  type KomutSonucu,
  semaylaSor,
  istemOlustur,
  surecBaslamadiMi,
} from './ortak.js';

const HATA_OZETI_SINIRI = 500;

/** Süreç başına bir kez: her beyin çağrısında aynı uyarıyı basmayalım. */
let apiAnahtariUyarildi = false;
/** Codex bu değişkenlerden biri varken abonelik yerine API anahtarını kullanabilir. */
const API_ANAHTARI_DEGISKENLERI = ['OPENAI_API_KEY', 'CODEX_API_KEY'] as const;

/**
 * `codex exec` stderr'i bir başlık (sürüm, workdir, model...) ve istemin kendisiyle başlar; asıl
 * hata sonda `ERROR: {...}` satırlarındadır. Baştan kesmek hatayı hep dışarıda bırakıyordu. Önce
 * ERROR satırlarını (JSON ise `error.message`) tekilleştirip alır, yoksa stderr'in SONUNU verir.
 */
export function codexHataOzeti(stderr: string, env?: NodeJS.ProcessEnv): string {
  const mesajlar: string[] = [];
  for (const satir of stderr.split(/\r?\n/)) {
    const eslesme = /^\s*ERROR:\s*(.*)$/.exec(satir);
    const govde = eslesme?.[1]?.trim();
    if (govde === undefined || govde === '') continue;
    let mesaj = govde;
    try {
      const ayrisilmis = JSON.parse(govde) as { error?: { message?: unknown }; message?: unknown };
      const ic = ayrisilmis.error?.message ?? ayrisilmis.message;
      if (typeof ic === 'string' && ic.trim() !== '') mesaj = ic.trim();
    } catch { /* düz metin ERROR satırı */ }
    if (!mesajlar.includes(mesaj)) mesajlar.push(mesaj);
  }
  const ozet = mesajlar.length > 0 ? mesajlar.join('; ') : stderr.trim().slice(-HATA_OZETI_SINIRI);
  return gizliDegerleriMaskele(ozet, env).slice(0, HATA_OZETI_SINIRI).trim();
}

export class CodexBeyni implements Beyin {
  readonly ad = 'codex';

  constructor(
    private readonly ayar: BeyinAyari,
    private readonly env: NodeJS.ProcessEnv,
    private readonly butce: BeyinButcesi,
  ) {}

  async sor<T>(istek: BeyinIstegi): Promise<BeyinYaniti<T>> {
    const baslangic = Date.now();
    const geciciDizin = await mkdtemp(join(tmpdir(), 'kobay-codex-'));
    const ciktiYolu = join(geciciDizin, 'yanit.txt');
    let sonIstem = istemOlustur(istek);
    let sonHam = '';
    try {
      const sonuc = await semaylaSor<T>(istek, async (istem) => {
        sonIstem = istem;
        const tanimliAnahtarlar = API_ANAHTARI_DEGISKENLERI.filter((ad) => (this.env[ad] ?? '') !== '');
        if (!apiAnahtariUyarildi && tanimliAnahtarlar.length > 0) {
          process.stderr.write(
            `[kobay] Warning: ${tanimliAnahtarlar.join(' and ')} ${tanimliAnahtarlar.length === 1 ? 'is' : 'are'} set;`
            + ' `codex exec` calls may be billed to your API account instead of your ChatGPT plan.\n',
          );
          apiAnahtariUyarildi = true;
        }
        const rezervasyon = this.butce.cagriBaslat();
        // Kullanıcının ~/.codex/config.toml'u (MCP sunucuları, profiller, varsayılanlar) beyin
        // koşusuna girmesin; oturum diske yazılmasın. Gereken ayarlar yalnız açık bayrakla verilir.
        const argumanlar = [
          'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
        ];
        if (this.ayar.model !== undefined) argumanlar.push('-m', this.ayar.model);
        if (this.ayar.effort !== undefined) argumanlar.push('-c', `model_reasoning_effort=${this.ayar.effort}`);
        argumanlar.push('-o', ciktiYolu, '-');
        let calisma: KomutSonucu;
        try {
          calisma = await komutSonucu('codex', argumanlar, {
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
        if (calisma.zamanAsimi || calisma.kod !== 0) {
          // Süreç başladı (zaman aşımı, sıfır dışı çıkış): sağlayıcı faturalamış olabilir, iade yok.
          this.butce.cagriHarcandi(rezervasyon);
          if (calisma.zamanAsimi) throw new BrainError('timeout');
          const ozet = codexHataOzeti(calisma.stderr, this.env);
          throw new BrainRuntimeError(
            'cli_error',
            `Codex exited with code ${calisma.kod ?? 'unknown'}${ozet === '' ? '.' : `: ${ozet}`}`,
          );
        }
        sonHam = await readFile(ciktiYolu, 'utf8').catch(() => calisma.stdout);
        this.butce.cagriTamamla(rezervasyon, 0);
        return { ham: sonHam };
      });
      await beyinGunluguYaz(istek.logDizini, istek.gorev, sonIstem, sonuc.ham, undefined, this.env);
      return { ...sonuc, sureMs: Date.now() - baslangic, adaptor: this.ad };
    } catch (hata) {
      const gunlukHam = hata instanceof BrainRuntimeError && hata.detay !== undefined ? hata.detay : sonHam;
      await beyinGunluguYaz(istek.logDizini, istek.gorev, sonIstem, gunlukHam, undefined, this.env);
      throw hata;
    } finally {
      await rm(geciciDizin, { recursive: true, force: true });
    }
  }
}
