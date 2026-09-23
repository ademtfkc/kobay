import type { Form, FormAlani, Harita, HaritaFarki, PlanAdimi, Sayfa, TestKaydi } from '../depo/index.js';

const BELGE_SINIRI = 20_000;
const ISTEM_SINIRI = 60_000;
const HARITA_SINIRI = 35_000;
const SAYFA_SINIRI = 2_000;

export const PLAN_SISTEM_ISTEMI = `Sen bir QA planlayıcısın. Deneyimli bir QA test planlayıcısı gibi davran.

8–25 öneri üret. Her öneri gerçek bir kullanıcı akışı olsun: haritadaki gerçek bir sayfaya url ile bağlan; steps 2–15 adım, action/assertion karışık ve en az bir assertion içersin. priority dağılımında p0 kritik akışlar (giriş, ana işlem), p1 önemli, p2 ikincil, p3 kozmetik için kullan. category giris, form, gezinti, veri, yetki veya hata-durumu gibi bir kategori; feature ise kısa bir ad olsun.

Haritadaki bir yol kalıbına uyan ama var olmayan kayıt URL'leri (ör. harita /cariler/36 içeriyorsa /cariler/999999) hata-durumu testi olarak önerilebilir; bunlar kabul edilir.

Silme ve çıkış gibi yıkıcı işlemleri yalnız açıkça geri alınabiliyorsa öner. E-posta gönderimi veya dış servis gibi test edilemeyecek şeyleri önerme.

Yalnız aşağıdaki JSON iskeletine uyan bir nesne döndür. proposalId gönderme; bunu sistem yerelde atar:
{"oneriler":[{"title":"...","description":"...","priority":"p1","category":"...","feature":"...","type":"frontend","url":"/ornek","steps":[{"type":"action","description":"..."},{"type":"assertion","description":"..."}]}]}

Tam örnek:
{"oneriler":[{"title":"Ürün listesini görüntüle","description":"Kullanıcının ürün sayfasını açıp listeyi gördüğünü doğrular.","priority":"p1","category":"gezinti","feature":"ürünler","type":"frontend","url":"/urunler","steps":[{"type":"action","description":"Ürünler sayfasını aç"},{"type":"assertion","description":"Ürün listesinin görünür olduğunu doğrula"}]}]}

title, description, priority, category, feature, type, url ve steps içindeki type ile description anahtarları İngilizce ve değişmezdir; bunları Türkçeye veya başka bir dile çevirme. Türkçe yalnız metin değerlerinde kalabilir.`;

function metniKes(metin: string, sinir: number): string {
  return metin.length <= sinir ? metin : `${metin.slice(0, sinir)}…[kesildi]`;
}

function listeOzeti(degerler: string[], ogeSiniri = 12, ogeKarakterSiniri = 140): string {
  const ozet = degerler.slice(0, ogeSiniri).map((deger) => metniKes(deger, ogeKarakterSiniri));
  const kalan = degerler.length - ozet.length;
  return kalan > 0 ? `${ozet.join(' | ')} | +${kalan}` : ozet.join(' | ');
}

function alanOzeti(alan: FormAlani): string {
  const etiket = alan.etiket === undefined ? '' : `, etiket: ${metniKes(alan.etiket, 100)}`;
  const placeholder = alan.placeholder === undefined ? '' : `, placeholder: ${metniKes(alan.placeholder, 100)}`;
  return `${metniKes(alan.ad, 100)} (${metniKes(alan.tip, 60)}${etiket}${placeholder})`;
}

function formOzeti(form: Form): string {
  const action = form.action === undefined ? '' : ` action=${metniKes(form.action, 160)}`;
  return `[${form.alanlar.slice(0, 16).map(alanOzeti).join('; ')}]${action}`;
}

function sayfaOzeti(sayfa: Sayfa): string {
  const metin = [
    `url: ${metniKes(sayfa.url, 500)}`,
    `başlık: ${metniKes(sayfa.baslik, 300)}`,
    `h1-h3: ${listeOzeti(sayfa.basliklar)}`,
    `form alanları: ${sayfa.formlar.slice(0, 8).map(formOzeti).join(' | ')}`,
    `düğmeler: ${listeOzeti(sayfa.dugmeler)}`,
    `menü: ${listeOzeti(sayfa.menu)}`,
  ].join('\n');
  return metniKes(metin, SAYFA_SINIRI);
}

function haritaOzeti(harita: Harita): string {
  let kalan = HARITA_SINIRI;
  const sayfalar: string[] = [];
  for (const [sira, sayfa] of harita.sayfalar.slice(0, 40).entries()) {
    const ozet = `Sayfa ${sira + 1}\n${sayfaOzeti(sayfa)}`;
    if (ozet.length > kalan) {
      if (kalan > 0) sayfalar.push(metniKes(ozet, kalan));
      sayfalar.push('…[harita kesildi]');
      break;
    }
    sayfalar.push(ozet);
    kalan -= ozet.length;
  }
  return `Temel URL: ${harita.baseUrl}\nGiriş yapıldı: ${harita.girisYapildi ? 'evet' : 'hayır'}\n\n${sayfalar.join('\n\n')}`;
}

/** Plan beyni için kullanıcı istemini kurar; birim testlerinde doğrudan kullanılabilir. */
export function planKullaniciIstemiOlustur(harita: Harita, belge: string | undefined, ipucu?: string): string {
  const belgeMetni = belge === undefined
    ? 'Belge sağlanmadı.'
    : metniKes(belge, BELGE_SINIRI);
  const ipucuBolumu = ipucu === undefined || ipucu === ''
    ? ''
    : `\n\n## Kullanıcı ipucu\n${metniKes(ipucu, 2_000)}`;
  const istem = `## Uygulama haritası\n${haritaOzeti(harita)}\n\n## Proje belgesi\n${belgeMetni}${ipucuBolumu}`;
  return metniKes(istem, ISTEM_SINIRI);
}

export const PLAN_YENILEME_SISTEM_ISTEMI = `Sen bir QA planlayıcısın. Bir test planı, hedef sayfa yeniden adlandırıldığı için bayatladı. Görevin testi yeniden yazmak değil, var olan adımları yeni arayüze uyarlamak.

Kurallar:
- Adım sayısını DEĞİŞTİRME. Kaç adım verildiyse tam o kadar adım döndür.
- Adımların sırasını ve niyetini koru: her adım eskisinin aynı işi yapan karşılığı olsun. action olan action, assertion olan assertion kalsın.
- Yalnız yeniden adlandırılmış öğeleri güncelle: eski sayfada olup yeni sayfada başka adla geçen başlık, düğme, menü veya form etiketlerini yeni adlarıyla yaz.
- Yeni adım, yeni doğrulama veya yeni akış EKLEME; eski bir adımı da atma.
- Yeni sayfada karşılığı olmayan bir öğe varsa adımı olabildiğince yakın bırak, uydurma öğe yazma.
- name alanı testin adıdır: içinde yeniden adlandırılmış bir öğe geçiyorsa güncelle, geçmiyorsa aynen döndür.

Yalnız aşağıdaki JSON iskeletine uyan bir nesne döndür:
{"name":"...","steps":[{"type":"action","description":"..."},{"type":"assertion","description":"..."}]}

Tam örnek (eski adımlarda "Cariler" geçiyordu, yeni sayfada "Müşteriler" yazıyor):
{"name":"Müşteriler listesini görüntüle","steps":[{"type":"action","description":"Müşteriler sayfasını aç"},{"type":"assertion","description":"Müşteriler başlığının görünür olduğunu doğrula"}]}

name, steps ve steps içindeki type ile description anahtarları İngilizce ve değişmezdir; bunları Türkçeye veya başka bir dile çevirme. Türkçe yalnız metin değerlerinde kalabilir.`;

function adimListesi(adimlar: readonly PlanAdimi[]): string {
  return adimlar
    .map((adim, sira) => `${sira}. [${adim.type}] ${metniKes(adim.description, 500)}`)
    .join('\n');
}

function haritaFarkiOzeti(fark: HaritaFarki): string {
  return [
    `url: ${metniKes(fark.url, 500)}`,
    `silinen başlıklar: ${listeOzeti(fark.silinenBasliklar)}`,
    `eklenen başlıklar: ${listeOzeti(fark.eklenenBasliklar)}`,
    `silinen düğmeler: ${listeOzeti(fark.silinenDugmeler)}`,
    `eklenen düğmeler: ${listeOzeti(fark.eklenenDugmeler)}`,
    `silinen form alanları: ${listeOzeti(fark.silinenFormAlanlari)}`,
    `eklenen form alanları: ${listeOzeti(fark.eklenenFormAlanlari)}`,
  ].join('\n');
}

export interface PlanYenilemeIstemBaglami {
  test: Pick<TestKaydi, 'name' | 'planSteps'>;
  eskiSayfa?: Sayfa;
  yeniSayfa: Sayfa;
  haritaFarki?: HaritaFarki;
}

/** Plan yenileme beyni için kullanıcı istemini kurar; birim testlerinde doğrudan kullanılabilir. */
export function planYenilemeKullaniciIstemiOlustur(baglam: PlanYenilemeIstemBaglami): string {
  const bolumler = [
    `## Testin adı\n${metniKes(baglam.test.name, 300)}`,
    `## Eski plan adımları (${baglam.test.planSteps.length} adım — bu sayı korunacak)\n${adimListesi(baglam.test.planSteps)}`,
    `## Sayfanın eski hâli (keşif haritasından)\n${baglam.eskiSayfa === undefined ? 'Eski özet yok.' : sayfaOzeti(baglam.eskiSayfa)}`,
    `## Sayfanın yeni hâli (şimdi keşfedildi)\n${sayfaOzeti(baglam.yeniSayfa)}`,
    `## Son hata paketindeki harita farkı\n${baglam.haritaFarki === undefined ? 'Fark bilgisi yok.' : haritaFarkiOzeti(baglam.haritaFarki)}`,
  ];
  return metniKes(bolumler.join('\n\n'), ISTEM_SINIRI);
}
