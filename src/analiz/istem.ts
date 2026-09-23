import type { AdimSonucu, HaritaFarki, TestKaydi } from '../depo/index.js';

export interface AnalizIstemBaglami {
  dusenAdim: AdimSonucu;
  hataMetni: string;
  ekranGoruntusu: { varMi: boolean; yol: string };
  dom: string | null;
  konsolHatalari: Array<{ tip: 'error' | 'warning'; metin: string; stepIndex?: number }>;
  agHatalari: Array<{ url: string; method: string; status?: number; hata?: string; stepIndex?: number }>;
  kod: string;
  test: TestKaydi;
  haritaFarki?: HaritaFarki;
}

export function analizSistemIstemiOlustur(): string {
  return `Sen tarayıcı testi başarısızlıklarında kök neden analistisin. Yalnızca verilen kanıta dayan; JSON şemasına eksiksiz uy.

Yalnız şu tam JSON iskeletine uyan bir nesne döndür:
{"rootCauseHypothesis":"...","failureKind":"test_bug","recommendedFixTarget":{"kind":"selector","reference":"...","rationale":"..."},"evidence":[{"kind":"snapshot","stepIndex":0,"summary":"..."}]}

rootCauseHypothesis, failureKind, recommendedFixTarget, kind, reference, rationale, evidence, stepIndex ve summary anahtarları İngilizce ve değişmezdir; bunları çevirme. Türkçe yalnız metin değerlerinde kalabilir.
failureKind yalnız product_bug, product_changed, test_bug, env, flaky veya unknown olabilir.
Metin değerlerinde Kobay'ın iç JSON alan adlarını (ör. sayfaKimligiUyusuyor, degisti, eklenenBasliklar) kullanma; bulguyu kullanıcı dilinde açıkla.

failureKind kuralları:
- Testin aradığı öğe keşif haritasında varken güncel DOM'da yoksa ve yerine benzer işi yapan yeni bir öğe gelmişse (yeniden adlandırma; silinen başlık/düğmenin karşısında eklenen bir başlık/düğme var): product_changed; recommendedFixTarget.kind: code. reference sayfa URL'sini ve eski → yeni öğeyi göstermeli. rationale keşfin bayatladığını, keşfin yenilenip testin yeniden üretilmesi gerektiğini söylemeli. Bunu test_bug ile karıştırma.
- Öğe silinmiş ve yerine bir şey gelmemişse (fark bloğunda silinen var, eklenen yok) bu product_changed DEĞİLDİR: ürün yanlışlıkla bozulmuş olabilir, product_bug düşün.
- Keşif haritasıyla fark bloğunda sayfaKimligiUyusuyor false ise sayfa artık keşifteki sayfa değildir (oturum düşmüş, giriş ekranına yönlenmiş olabilir): product_changed deme; env ya da unknown düşün.
- Seçici bulunamadı ve DOM'da benzer öğe varsa: test_bug; recommendedFixTarget.kind: selector. reference test kodundaki satırı veya seçiciyi göstermeli.
- Hedef 5xx, ağ hatası ya da zaman aşımı ise: env; recommendedFixTarget.kind: env.
- Öğe DOM'da var ama assertion metni uyuşmuyorsa: product_bug; recommendedFixTarget.kind: code. reference sayfa URL'sini ve ilgili öğeyi tarif etmeli.
- recommendedFixTarget.kind code ve failureKind product_bug ise rationale, kaynak dosyayı bulmak için ürün kodunda hata mesajındaki beklenmeyen Received değerini/metnini arama ipucu vermeli.
- Kanıt yeterli değilse: unknown; recommendedFixTarget.kind: unknown.

evidence en fazla 6 madde olsun. Her madde yalnız kind, stepIndex ve kısa summary içersin; dosya yolu yazma.
evidence.kind yalnız screenshot, snapshot, console, network veya log olabilir; dom, diff, error gibi başka değer kullanma (DOM gözlemi için snapshot, hata metni için log, harita farkı için snapshot).`;
}

function jsonBlok(baslik: string, veri: unknown): string {
  return `## ${baslik}\n${JSON.stringify(veri, null, 2)}`;
}

/** Beyne taşınacak hata bağlamını kurar; konsol ve ağ kayıtlarını 20'şer adetle sınırlar. */
export function analizKullaniciIstemiOlustur(baglam: AnalizIstemBaglami): string {
  return [
    '# Başarısız test analizi',
    jsonBlok('Test', { id: baglam.test.id, ad: baglam.test.name, url: baglam.test.url ?? null }),
    jsonBlok('Düşen adım', baglam.dusenAdim),
    `## Hata metni\n${baglam.hataMetni}`,
    jsonBlok('Ekran görüntüsü', baglam.ekranGoruntusu),
    `## Temizlenmiş DOM\n${baglam.dom ?? '[DOM dosyası yok]'}`,
    baglam.haritaFarki === undefined
      ? '## Keşif haritasıyla fark\n[harita farkı yok]'
      : [
        jsonBlok('Keşif haritasıyla fark', baglam.haritaFarki),
        baglam.haritaFarki.sayfaKimligiUyusuyor
          ? 'sayfaKimligiUyusuyor true: DOM hâlâ keşifteki sayfayı gösteriyor.'
          : 'sayfaKimligiUyusuyor false: DOM keşifteki sayfa değil (ör. oturum düşmüş, giriş ekranına yönlenmiş). product_changed deme; env ya da unknown düşün.',
      ].join('\n'),
    jsonBlok('Konsol hataları (en fazla 20)', baglam.konsolHatalari.slice(0, 20)),
    jsonBlok('Ağ hataları (en fazla 20)', baglam.agHatalari.slice(0, 20)),
    `## Test kodu\n${baglam.kod || '[Test kodu yok]'}`,
    jsonBlok('Plan adımları', baglam.test.planSteps),
  ].join('\n\n');
}
