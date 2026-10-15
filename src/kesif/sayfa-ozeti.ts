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
  dugmeler: string[];
  disclosures: string[];
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
  /** Etiketin kendi metni; kontrolün ve diğer form kontrollerinin iç metni (option dahil) sayılmaz. */
  const etiketMetni = (etiket: Element, kontrol: Kontrol): string => {
    const parcalar: string[] = [];
    const yuru = (dugum: Node): void => {
      if (dugum === kontrol) return;
      if (dugum.nodeType === Node.TEXT_NODE) {
        parcalar.push(dugum.textContent ?? '');
      } else if (dugum.nodeType === Node.ELEMENT_NODE) {
        if (/^(select|textarea|script|style)$/i.test((dugum as Element).tagName)) return;
        if (!(dugum as Element).checkVisibility()) return;
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
      const metin = temizle(
        baglilar.split(' ').map((hedef) => (kontrol.getRootNode() as Document | ShadowRoot).getElementById(hedef)?.textContent ?? '').join(' '),
      );
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
        .filter((secenek) => !secenek.disabled && secenek.closest('optgroup[disabled]') === null)
        .map((secenek) => temizle(secenek.textContent))
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

  const dugmeler = tumu(
    'button, [role="button"], input[type="submit"], input[type="button"]',
  ).map((eleman) => {
    const girdi = eleman instanceof HTMLInputElement;
    const gorunen = girdi ? '' : temizle((eleman as HTMLElement).innerText);
    return gorunen
      || temizle(eleman.getAttribute('aria-label'))
      || temizle(eleman.getAttribute('title'))
      || temizle((eleman as HTMLInputElement | HTMLButtonElement).value);
  });
  const disclosures = tumu('details > summary').map((e) => temizle(e.textContent));
  return { formlar, dugmeler, disclosures };
}

/** Bir Playwright sayfasındaki test-planı için gerekli görünür arayüz bilgisini çıkarır. */
export async function sayfaOzeti(sayfa: Page, koken: string): Promise<Sayfa> {
  const baslik = metniTemizle(await sayfa.title())
    || metniTemizle((await sayfa.locator('h1').first().allTextContents())[0] ?? '');
  const basliklar = benzersiz((await sayfa.locator('h1, h2, h3').allTextContents()).map(metniTemizle), 30);
  const hamLinkler = await sayfa.locator('a[href]').evaluateAll((baglantilar) =>
    baglantilar.map((baglanti) => ({ href: (baglanti as HTMLAnchorElement).href })),
  );
  const linkler = benzersiz(
    hamLinkler
      .map(({ href }) => normalUrl(href))
      .filter((url): url is string => url !== null && new URL(url).origin === koken),
    SINIRLAR.link,
  );
  const { formlar, dugmeler: hamDugmeler, disclosures: hamDisclosures } = await sayfa.evaluate(okuDom, SINIRLAR);
  const dugmeler = benzersiz(hamDugmeler.map(metniTemizle), SINIRLAR.dugme);
  const disclosures = benzersiz(hamDisclosures.map(metniTemizle), SINIRLAR.disclosure);
  const menu = benzersiz((await sayfa.locator('nav a').allTextContents()).map(metniTemizle), 100);

  return {
    url: normalUrl(sayfa.url()) ?? sayfa.url(),
    title: baslik,
    headings: basliklar,
    links: linkler,
    forms: formlar,
    buttons: dugmeler,
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
 * (bağlantı metni), disclosure, alan etiketi, placeholder ve seçenekler. Yapısal alanlar (`url`,
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
    menu: metinler(sayfa.menu),
    ...(sayfa.disclosures === undefined ? {} : { disclosures: metinler(sayfa.disclosures) }),
  };
}
