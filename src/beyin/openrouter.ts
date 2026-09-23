import type { BeyinAyari } from '../depo/index.js';
import { BeyinCalismaHatasi, BeyinHatasi, type Beyin, type BeyinIstegi, type BeyinYaniti } from './index.js';
import {
  beyinGunluguYaz,
  type BeyinButcesi,
  type BeyinKullanimi,
  semaylaSor,
  istemOlustur,
} from './ortak.js';

const VARSAYILAN_OPENROUTER_MODELI = 'google/gemini-3.8-flash';
const ISTEK_EK_TOKEN_TAVANI = 1024;

interface OpenRouterFiyati {
  prompt: number;
  completion: number;
  request: number;
}

function maliyetOku(deger: unknown): number | undefined {
  const maliyet = typeof deger === 'number' ? deger : typeof deger === 'string' ? Number(deger) : Number.NaN;
  return Number.isFinite(maliyet) && maliyet >= 0 ? maliyet : undefined;
}

function fiyatOku(deger: unknown): number | undefined {
  return maliyetOku(deger);
}

/**
 * OpenRouter /api/v1/model(s) yanıtı `pricing.request` alanını çoğu (Eyl 2026'da hiçbir) modelde
 * döndürmüyor; alan YOKSA istek başı ücret 0 sayılır. Alan VARSA geçerli olmak zorunda: bozuk değer
 * fiyatı bilinmeyen modeldir, çağrı başlatılmaz.
 */
function istekFiyatiOku(deger: unknown): number | undefined {
  if (deger === undefined || deger === null) return 0;
  return fiyatOku(deger);
}

function modelFiyatYolu(model: string): string | null {
  const ayrac = model.indexOf('/');
  if (ayrac <= 0 || ayrac === model.length - 1) return null;
  return `https://openrouter.ai/api/v1/model/${encodeURIComponent(model.slice(0, ayrac))}/${encodeURIComponent(model.slice(ayrac + 1))}`;
}

export class OpenRouterBeyni implements Beyin {
  readonly ad = 'openrouter';
  private fiyatSozu?: Promise<OpenRouterFiyati>;

  constructor(
    private readonly ayar: BeyinAyari,
    private readonly env: NodeJS.ProcessEnv,
    private readonly butce: BeyinButcesi,
  ) {}

  private fiyatlariGetir(anahtar: string): Promise<OpenRouterFiyati> {
    this.fiyatSozu ??= (async () => {
      const model = this.ayar.model ?? VARSAYILAN_OPENROUTER_MODELI;
      const yol = modelFiyatYolu(model);
      if (yol === null) {
        throw new BeyinCalismaHatasi(
          'maliyet_bilinmiyor',
          `OpenRouter model kimliği fiyat sorgusuna uygun değil: ${model}. Çağrı başlatılmadı.`,
        );
      }
      let cevap: Response;
      try {
        cevap = await fetch(yol, { headers: { Authorization: `Bearer ${anahtar}` } });
      } catch {
        throw new BeyinCalismaHatasi(
          'maliyet_bilinmiyor',
          `OpenRouter ${model} fiyatı alınamadı; çağrı başlatılmadı. Ağ bağlantısını ve model adını denetleyin.`,
        );
      }
      if (!cevap.ok) {
        throw new BeyinCalismaHatasi(
          'maliyet_bilinmiyor',
          `OpenRouter ${model} fiyatı doğrulanamadı (HTTP ${cevap.status}); çağrı başlatılmadı.`,
        );
      }
      let veri: { data?: { pricing?: { prompt?: unknown; completion?: unknown; request?: unknown } } };
      try {
        veri = await cevap.json() as typeof veri;
      } catch {
        throw new BeyinCalismaHatasi(
          'maliyet_bilinmiyor',
          `OpenRouter ${model} fiyat yanıtı ayrıştırılamadı; çağrı başlatılmadı.`,
        );
      }
      const prompt = fiyatOku(veri.data?.pricing?.prompt);
      const completion = fiyatOku(veri.data?.pricing?.completion);
      const request = istekFiyatiOku(veri.data?.pricing?.request);
      if (prompt === undefined || completion === undefined || request === undefined) {
        throw new BeyinCalismaHatasi(
          'maliyet_bilinmiyor',
          `OpenRouter ${model} fiyat bilgisinde prompt veya completion alanı yok ya da request alanı geçersiz; çağrı başlatılmadı.`,
        );
      }
      return { prompt, completion, request };
    })();
    return this.fiyatSozu;
  }

  async sor<T>(istek: BeyinIstegi): Promise<BeyinYaniti<T>> {
    const anahtar = this.env.OPENROUTER_API_KEY;
    if (anahtar === undefined || anahtar === '') throw new BeyinHatasi('anahtar_yok');
    const baslangic = Date.now();
    let sonIstem = istemOlustur(istek);
    let sonHam = '';
    let sonKullanim: BeyinKullanimi | undefined;
    try {
      const sonuc = await semaylaSor<T>(istek, async (istem) => {
        sonIstem = istem;
        const fiyat = await this.fiyatlariGetir(anahtar);
        const istemTokenTavani = Buffer.byteLength(istem, 'utf8') + ISTEK_EK_TOKEN_TAVANI;
        const azamiMaliyetUsd = fiyat.request
          + istemTokenTavani * fiyat.prompt
          + this.butce.openRouterMaxTokens * fiyat.completion;
        const rezervasyon = this.butce.cagriBaslat(azamiMaliyetUsd);
        try {
          const cevap = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${anahtar}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: this.ayar.model ?? VARSAYILAN_OPENROUTER_MODELI,
              messages: [{ role: 'user', content: istem }],
              response_format: { type: 'json_object' },
              max_tokens: this.butce.openRouterMaxTokens,
              usage: { include: true },
              provider: {
                max_price: {
                  prompt: fiyat.prompt * 1_000_000,
                  completion: fiyat.completion * 1_000_000,
                },
              },
            }),
            signal: AbortSignal.timeout((istek.zamanAsimiSn ?? 180) * 1000),
          });
          if (!cevap.ok) throw new BeyinHatasi('ag');
          const veri = await cevap.json() as {
            choices?: Array<{ message?: { content?: unknown } }>;
            usage?: { cost?: unknown };
          };
          sonHam = typeof veri.choices?.[0]?.message?.content === 'string' ? veri.choices[0].message.content : '';
          const maliyetUsd = maliyetOku(veri.usage?.cost);
          sonKullanim = maliyetUsd === undefined ? {} : { maliyetUsd };
          this.butce.cagriTamamla(rezervasyon, maliyetUsd);
          return { ham: sonHam, ...sonKullanim };
        } catch (hata) {
          // İstek gönderildikten sonraki her hata (zaman aşımı, ağ, HTTP hatası): sağlayıcı faturalamış
          // olabilir, rezervasyon iade edilmez. cagriTamamla zaten kapattıysa bu çağrı etkisizdir.
          this.butce.cagriHarcandi(rezervasyon);
          if (hata instanceof BeyinHatasi || hata instanceof BeyinCalismaHatasi) throw hata;
          if (hata instanceof DOMException && hata.name === 'TimeoutError') throw new BeyinHatasi('zaman_asimi');
          throw new BeyinHatasi('ag');
        }
      });
      await beyinGunluguYaz(istek.logDizini, istek.gorev, sonIstem, sonuc.ham, sonuc);
      return { ...sonuc, sureMs: Date.now() - baslangic, adaptor: this.ad };
    } catch (hata) {
      const gunlukHam = hata instanceof BeyinCalismaHatasi && hata.detay !== undefined ? hata.detay : sonHam;
      await beyinGunluguYaz(istek.logDizini, istek.gorev, sonIstem, gunlukHam, sonKullanim);
      throw hata;
    }
  }
}
