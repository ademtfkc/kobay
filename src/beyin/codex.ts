import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BeyinAyari } from '../depo/index.js';
import { BrainRuntimeError, type Beyin, type BeyinIstegi, type BeyinYaniti } from './index.js';
import {
  beyinGunluguYaz,
  type BeyinButcesi,
  komutCalistir,
  semaylaSor,
  istemOlustur,
  surecBaslamadiMi,
} from './ortak.js';

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
        const rezervasyon = this.butce.cagriBaslat();
        // Kullanıcının ~/.codex/config.toml'u (MCP sunucuları, profiller, varsayılanlar) beyin
        // koşusuna girmesin; oturum diske yazılmasın. Gereken ayarlar yalnız açık bayrakla verilir.
        const argumanlar = [
          'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
        ];
        if (this.ayar.model !== undefined) argumanlar.push('-m', this.ayar.model);
        if (this.ayar.effort !== undefined) argumanlar.push('-c', `model_reasoning_effort=${this.ayar.effort}`);
        argumanlar.push('-o', ciktiYolu, '-');
        try {
          const calisma = await komutCalistir('codex', argumanlar, {
            girdi: istem,
            env: this.env,
            cwd: geciciDizin,
            ...(istek.zamanAsimiSn === undefined ? {} : { zamanAsimiSn: istek.zamanAsimiSn }),
          });
          sonHam = await readFile(ciktiYolu, 'utf8').catch(() => calisma.stdout);
          this.butce.cagriTamamla(rezervasyon, 0);
          return { ham: sonHam };
        } catch (hata) {
          // Süreç başladıysa (zaman aşımı, sıfır dışı çıkış) sağlayıcı faturalamış olabilir: iade yok.
          if (surecBaslamadiMi(hata)) this.butce.cagriIptal(rezervasyon);
          else this.butce.cagriHarcandi(rezervasyon);
          throw hata;
        }
      });
      await beyinGunluguYaz(istek.logDizini, istek.gorev, sonIstem, sonuc.ham);
      return { ...sonuc, sureMs: Date.now() - baslangic, adaptor: this.ad };
    } catch (hata) {
      const gunlukHam = hata instanceof BrainRuntimeError && hata.detay !== undefined ? hata.detay : sonHam;
      await beyinGunluguYaz(istek.logDizini, istek.gorev, sonIstem, gunlukHam);
      throw hata;
    } finally {
      await rm(geciciDizin, { recursive: true, force: true });
    }
  }
}
