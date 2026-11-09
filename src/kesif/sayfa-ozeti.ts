import type { Page } from '@playwright/test';
import type { Form, FormAlani, Sayfa } from '../depo/index.js';

function metniTemizle(metin: string): string {
  return metin.replace(/\s+/g, ' ').trim();
}

function benzersiz(metinler: string[], sinir: number): string[] {
  return [...new Set(metinler.filter(Boolean))].slice(0, sinir);
}

function normalUrl(adres: string): string | null {
  try {
    const url = new URL(adres);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    url.search = '';
    return url.href;
  } catch {
    return null;
  }
}

/** Sayfa başına tavanlar (sessiz kesim); tek yerde durur. */
// golgeDerinlik: 11+ katman iç içe açık shadow kökü okunmaz, bilinen sınır (spec §7).
const SINIRLAR = { alan: 100, secenek: 20, disclosure: 20, link: 100, dugme: 50, golgeDerinlik: 10 } as const;

/**
 * Tarayıcıda koşar (page.evaluate): Node tarafındaki hiçbir şeye erişemez, kendi içinde tam olmalı.
 * Form, düğme ve disclosure bilgisini tek geçişte okur.
 */
function okuDom(sinir: { alan: number; secenek: number; golgeDerinlik: number }): {
  formlar: Form[];
  dugmeler: { ad: string; devreDisi: boolean }[];
  disclosures: string[];
  basliklar: string[];
  h1ler: string[];
  menu: string[];
} {
  const temizle = (metin: string | null | undefined): string => (metin ?? '').replace(/\s+/g, ' ').trim();
  /** Belge ve açık shadow kökleri boyunca seçiciyi arar (kapalı shadow görünmez); derinlik tavanlı. */
  const tumu = (secici: string, kok: ParentNode = document, derinlik = 0): Element[] => {
    const bulunan = Array.from(kok.querySelectorAll(secici));
    if (derinlik >= sinir.golgeDerinlik) return bulunan;
    for (const eleman of Array.from(kok.querySelectorAll('*'))) {
      if (eleman.shadowRoot) bulunan.push(...tumu(secici, eleman.shadowRoot, derinlik + 1));
    }
    return bulunan;
  };
  type Kontrol = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  /**
   * Gizli metin haritaya girmez; düğme adı ve alan etiketi bu tek kuralı kullanır. Gizli: öğe ya da
   * bir atası (açık gölge kökünden host'a çıkarak) aria-hidden ise, görünmüyorsa (display,
   * visibility) ya da KENDİSİ opacity:0 ise. Opaklık atadan miras alınmaz: üzerine gelince beliren
   * düğme (opacity:0 kapsayıcı) erişilebilirlik ağacında durur, adı haritada kalmalı. Ağaç yürünürken
   * her alt öğe ayrıca denetlendiği için ad/etiket içindeki opacity:0 parça yine düşer.
   * `opaklik: false`: düğmenin kendisi için; opacity:0 düğme (üzerine gelince beliren) gizli sayılmaz.
   * aria-hidden değeri tarayıcı gibi büyük/küçük harf ve boşluk duyarsız okunur ("TRUE", " true ").
   */
  const gizli = (eleman: Element, opaklik = true): boolean => {
    for (let ata: Element | null = eleman; ata !== null;) {
      if ((ata.getAttribute('aria-hidden') ?? '').trim().toLowerCase() === 'true') return true;
      const kok: ParentNode | null = ata.parentNode;
      ata = kok instanceof ShadowRoot ? kok.host : ata.parentElement;
    }
    if (!eleman.checkVisibility({ visibilityProperty: true })) return true;
    return opaklik && getComputedStyle(eleman).opacity === '0';
  };
  /** Seçenek: kapalı select içinde kutusu olmaz (checkVisibility yanıltır); hidden, display:none ve aria-hidden bakılır. */
  const secenekGizli = (secenek: HTMLOptionElement): boolean => {
    // Üstteki select/optgroup/atalar da sayılır (display:none, visibility:hidden, hidden, aria-hidden).
    for (let e: Element | null = secenek; e !== null;) {
      if (e instanceof HTMLElement && e.hidden) return true;
      if ((e.getAttribute('aria-hidden') ?? '').trim().toLowerCase() === 'true') return true;
      const stil = getComputedStyle(e);
      if (stil.display === 'none' || stil.visibility === 'hidden') return true;
      const kok: ParentNode | null = e.parentNode;
      e = kok instanceof ShadowRoot ? kok.host : e.parentElement;
    }
    return false;
  };
  /** Etiketin kendi metni; kontrolün ve diğer form kontrollerinin iç metni (option dahil) sayılmaz. */
  const etiketMetni = (etiket: Element, kontrol: Kontrol): string => {
    if (gizli(etiket)) return '';
    const parcalar: string[] = [];
    const yuru = (dugum: Node): void => {
      if (dugum === kontrol) return;
      if (dugum.nodeType === Node.TEXT_NODE) {
        parcalar.push(dugum.textContent ?? '');
      } else if (dugum.nodeType === Node.ELEMENT_NODE) {
        if (/^(select|textarea|script|style)$/i.test((dugum as Element).tagName)) return;
        if (gizli(dugum as Element)) return;
        dugum.childNodes.forEach(yuru);
      }
    };
    etiket.childNodes.forEach(yuru);
    return temizle(parcalar.join(' '));
  };
  const etiketBul = (kontrol: Kontrol): string => {
    const id = kontrol.getAttribute('id');
    if (id) {
      const kok = kontrol.getRootNode() as Document | ShadowRoot;
      for (const etiket of Array.from(kok.querySelectorAll('label[for]'))) {
        if (etiket.getAttribute('for') !== id) continue;
        const metin = etiketMetni(etiket, kontrol);
        if (metin) return metin;
      }
    }
    const baglilar = temizle(kontrol.getAttribute('aria-labelledby'));
    if (baglilar) {
      // Başvurulan öğe de etiket gibi okunur: kendisi ya da parçası gizliyse metni girmez.
      const metin = temizle(baglilar.split(' ').map((hedef) => {
        const bagli = (kontrol.getRootNode() as Document | ShadowRoot).getElementById(hedef);
        return bagli === null ? '' : etiketMetni(bagli, kontrol);
      }).join(' '));
      if (metin) return metin;
    }
    const aria = temizle(kontrol.getAttribute('aria-label'));
    if (aria) return aria;
    const kapsayan = kontrol.closest('label');
    if (kapsayan) {
      const metin = etiketMetni(kapsayan, kontrol);
      if (metin) return metin;
    }
    return '';
  };

  const kontroller = tumu('input, select, textarea')
    .map((eleman) => eleman as Kontrol)
    .filter((kontrol) => (kontrol.getAttribute('type') ?? '').toLowerCase() !== 'hidden')
    .slice(0, sinir.alan);
  const alanOlustur = (kontrol: Kontrol): FormAlani => {
    const id = kontrol.getAttribute('id');
    const alan: FormAlani = {
      name: kontrol.getAttribute('name') ?? id ?? '',
      type: kontrol.getAttribute('type') ?? kontrol.tagName.toLowerCase(),
    };
    const etiket = etiketBul(kontrol);
    const placeholder = temizle(kontrol.getAttribute('placeholder'));
    if (etiket) alan.label = etiket;
    else if (placeholder) alan.label = placeholder;
    if (placeholder) alan.placeholder = placeholder;
    if (kontrol instanceof HTMLSelectElement) {
      const gecerli = Array.from(kontrol.options)
        .filter((secenek) => !secenek.disabled && secenek.closest('optgroup[disabled]') === null && !secenekGizli(secenek))
        .map((secenek) => temizle(secenek.getAttribute('aria-label')) || temizle(secenek.textContent))
        .filter(Boolean);
      alan.options = gecerli.slice(0, sinir.secenek);
      // optionCount: kullanılabilir (boş ve disabled olmayan) seçenek sayısı; options listesiyle tutarlı.
      alan.optionCount = gecerli.length;
    }
    return alan;
  };

  const formlar: Form[] = tumu('form').map((form) => {
    const sonuc: Form = { fields: kontroller.filter((kontrol) => kontrol.form === form).map(alanOlustur) };
    const action = form.getAttribute('action');
    if (action) sonuc.action = action;
    return sonuc;
  });
  const serbest = kontroller.filter((kontrol) => kontrol.form === null);
  if (serbest.length > 0) formlar.push({ detached: true, fields: serbest.map(alanOlustur) });

  /**
   * İçerikten gelen ad: ham metin düğümlerinden okunur, CSS `text-transform` (ör. büyük harf)
   * ada girmez. Gizli alt öğeler (bkz. `gizli`) sayılmaz; img alt sayılır.
   */
  const icerikAdi = (kok: Element): string => {
    const parcalar: string[] = [];
    const yuru = (dugum: Node): void => {
      if (dugum.nodeType === Node.TEXT_NODE) {
        parcalar.push(dugum.textContent ?? '');
        return;
      }
      if (dugum.nodeType !== Node.ELEMENT_NODE) return;
      const eleman = dugum as Element;
      if (/^(script|style|template)$/i.test(eleman.tagName)) return;
      if (gizli(eleman)) return;
      if (eleman instanceof HTMLImageElement) {
        parcalar.push(` ${eleman.alt} `);
        return;
      }
      // Satır içi olmayan alt öğe ayrı kelimedir ("Add" + <div>task</div> → "Add task").
      const ayri = getComputedStyle(eleman).display !== 'inline';
      if (ayri) parcalar.push(' ');
      eleman.childNodes.forEach(yuru);
      if (ayri) parcalar.push(' ');
    };
    kok.childNodes.forEach(yuru);
    return temizle(parcalar.join(''));
  };
  /**
   * Erişilebilir ad (getByRole'ün eşlediği ad), sadeleştirilmiş sırayla: aria-labelledby >
   * aria-label > içerik (girdi düğmesinde value) > title.
   */
  const erisilebilirAd = (eleman: Element): string => {
    // Gizli düğme (kendisi ya da atası) erişilebilirlik ağacında yoktur: adı (aria-label dahil) haritaya girmez.
    if (gizli(eleman, false)) return '';
    const baglilar = temizle(eleman.getAttribute('aria-labelledby'));
    if (baglilar) {
      const kok = eleman.getRootNode() as Document | ShadowRoot;
      const metin = temizle(baglilar.split(' ').map((hedef) => {
        const bagli = kok.getElementById(hedef);
        // Gizli metin haritaya girmez: başvurulan öğenin kendisi (ya da bir atası) gizliyse okunmaz.
        // Erişilebilir ad hesabı bunu okurdu; burada sızıntı önceliklidir, ad bir sonraki basamağa düşer.
        if (bagli === null || gizli(bagli)) return '';
        return icerikAdi(bagli);
      }).join(' '));
      if (metin) return metin;
    }
    const aria = temizle(eleman.getAttribute('aria-label'));
    if (aria) return aria;
    const icerik = eleman instanceof HTMLInputElement ? temizle(eleman.value) : icerikAdi(eleman);
    return icerik || temizle(eleman.getAttribute('title'));
  };
  const dugmeler = tumu(
    'button, [role="button"], input[type="submit"], input[type="button"]',
  ).map((eleman) => ({
    ad: erisilebilirAd(eleman),
    // Devre dışı durum da okunur: plan, kapalı düğmeye basılan bir akış önermesin.
    devreDisi: eleman.matches(':disabled') || eleman.getAttribute('aria-disabled') === 'true',
  }));
  const disclosures = tumu('details > summary').map(erisilebilirAd);
  // Başlık, menü bağlantısı ve disclosure düğme adıyla aynı kuralı kullanır: gizli olan girmez, aria-label kazanır.
  const basliklar = tumu('h1, h2, h3').map(erisilebilirAd);
  const h1ler = tumu('h1').map(erisilebilirAd);
  const menu = tumu('nav a').map(erisilebilirAd);
  return { formlar, dugmeler, disclosures, basliklar, h1ler, menu };
}

/** Bir Playwright sayfasındaki test-planı için gerekli görünür arayüz bilgisini çıkarır. */
export async function sayfaOzeti(sayfa: Page, koken: string): Promise<Sayfa> {
  const baslikMetni = metniTemizle(await sayfa.title());
  const hamLinkler = await sayfa.locator('a[href]').evaluateAll((baglantilar) =>
    baglantilar.map((baglanti) => ({ href: (baglanti as HTMLAnchorElement).href })),
  );
  const linkler = benzersiz(
    hamLinkler
      .map(({ href }) => normalUrl(href))
      .filter((url): url is string => url !== null && new URL(url).origin === koken),
    SINIRLAR.link,
  );
  const { formlar, dugmeler: hamDugmeler, disclosures: hamDisclosures, basliklar: hamBasliklar, h1ler, menu: hamMenu }
    = await sayfa.evaluate(okuDom, SINIRLAR);
  const baslik = baslikMetni || (h1ler.map(metniTemizle).find(Boolean) ?? '');
  const basliklar = benzersiz(hamBasliklar.map(metniTemizle), 30);
  const dugmeler = benzersiz(hamDugmeler.map(({ ad }) => metniTemizle(ad)), SINIRLAR.dugme);
  // Aynı adlı düğmelerden biri açıksa ad devre dışı sayılmaz; liste `buttons`'un alt kümesidir.
  const acikAdlar = new Set(hamDugmeler.filter(({ devreDisi }) => !devreDisi).map(({ ad }) => metniTemizle(ad)));
  const devreDisiDugmeler = dugmeler.filter((ad) => !acikAdlar.has(ad));
  const disclosures = benzersiz(hamDisclosures.map(metniTemizle), SINIRLAR.disclosure);
  const menu = benzersiz(hamMenu.map(metniTemizle), 100);

  return {
    url: normalUrl(sayfa.url()) ?? sayfa.url(),
    title: baslik,
    headings: basliklar,
    links: linkler,
    forms: formlar,
    buttons: dugmeler,
    ...(devreDisiDugmeler.length > 0 ? { disabledButtons: devreDisiDugmeler } : {}),
    menu,
    ...(disclosures.length > 0 ? { disclosures } : {}),
  };
}

/** Harita maskesi (bkz. `haritaMaskesi`): yalnız serbest metin; adreslere dokunmaz, gerekirse kaydı düşürür. */
export interface SayfaMaskesi {
  metin(deger: string): string;
  yapisalDusur(deger: string): boolean;
}

/**
 * Sayfa özetini maskeler. YALNIZ görünen serbest metin değişir: başlık, başlıklar, düğme, menü
 * (bağlantı metni), devre dışı düğme, disclosure, alan etiketi, placeholder ve seçenekler. Yapısal alanlar (`url`,
 * `links`, form `action`, `redirectedTo`, alan `name`/`type`) HİÇBİR ZAMAN değiştirilmez; tek
 * istisna: maske bir bağlantıyı, `action`'ı ya da alanın `name`/`type`'ını sır taşıyor sayarsa
 * (`yapisalDusur`) o bağlantı/alan düşer, `action` kaldırılır. Sayfa kaydı ve adresi olduğu gibi kalır.
 */
export function sayfaMetinleriniGizle(sayfa: Sayfa, maske: SayfaMaskesi): Sayfa {
  const metinler = (degerler: readonly string[]): string[] => degerler.map((deger) => maske.metin(deger));
  return {
    ...sayfa,
    title: maske.metin(sayfa.title),
    headings: metinler(sayfa.headings),
    links: sayfa.links.filter((link) => !maske.yapisalDusur(link)),
    forms: sayfa.forms.map((form) => {
      const { action, ...geri } = form;
      return {
        ...(action === undefined || maske.yapisalDusur(action) ? {} : { action }),
        ...geri,
        // `name`/`type` seçici olarak kalır; oturum değeri taşıyan alan maskelenmez, düşer.
        fields: form.fields.filter((alan) => !maske.yapisalDusur(alan.name) && !maske.yapisalDusur(alan.type)).map((alan) => ({
          ...alan,
          ...(alan.label === undefined ? {} : { label: maske.metin(alan.label) }),
          ...(alan.placeholder === undefined ? {} : { placeholder: maske.metin(alan.placeholder) }),
          ...(alan.options === undefined ? {} : { options: metinler(alan.options) }),
        })),
      };
    }),
    buttons: metinler(sayfa.buttons),
    ...(sayfa.disabledButtons === undefined ? {} : { disabledButtons: metinler(sayfa.disabledButtons) }),
    menu: metinler(sayfa.menu),
    ...(sayfa.disclosures === undefined ? {} : { disclosures: metinler(sayfa.disclosures) }),
  };
}
