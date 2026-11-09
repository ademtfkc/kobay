import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { HaritaSemasi } from '../../src/depo/semalar.js';
import { sayfaMetinleriniGizle, sayfaOzeti } from '../../src/kesif/sayfa-ozeti.js';

let tarayici: Browser;
let sayfa: Page;

beforeAll(async () => {
  tarayici = await chromium.launch({ headless: true });
  sayfa = await tarayici.newPage();
});
afterAll(async () => { await tarayici?.close(); });

async function ozet(html: string) {
  await sayfa.setContent(`<!doctype html><title>t</title><body>${html}</body>`);
  return sayfaOzeti(sayfa, 'http://uygulama.test');
}

function secenekler(sayi: number): string {
  return Array.from({ length: sayi }, (_, i) => `<option value="${i}">Seçenek ${i}</option>`).join('');
}

describe('sayfaOzeti: form dışı alanlar (A1)', () => {
  it('form dışındaki 4 select + 2 input tek sanal forma girer', async () => {
    const o = await ozet(`
      <select name="a"><option>x</option></select><select name="b"><option>x</option></select>
      <select name="c"><option>x</option></select><select name="d"><option>x</option></select>
      <input name="e"><input name="f">`);
    expect(o.forms).toHaveLength(1);
    expect(o.forms[0]?.detached).toBe(true);
    expect(o.forms[0]).not.toHaveProperty('action');
    expect(o.forms[0]?.fields.map(({ name }) => name)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('form dışı alan yoksa sanal form üretmez; form içi alan gerçek forma gider', async () => {
    const o = await ozet('<form action="/g"><input name="k"></form>');
    expect(o.forms).toHaveLength(1);
    expect(o.forms[0]?.detached).toBeUndefined();
    expect(o.forms[0]?.action).toBe('/g');
  });

  it('formlu ve formsuz alanlar birlikte: gerçek form + tek sanal form', async () => {
    const o = await ozet('<form><input name="ic"></form><input name="dis1"><textarea name="dis2"></textarea>');
    expect(o.forms.map((f) => f.detached === true)).toEqual([false, true]);
    expect(o.forms[1]?.fields.map(({ name }) => name)).toEqual(['dis1', 'dis2']);
  });
});

describe('sayfaOzeti: gizli alan (A2)', () => {
  it('type=hidden haritada yok, adı $ACTION_ID_ olan dahil; görünür alan kalır', async () => {
    const o = await ozet(`<form action="/g">
      <input type="hidden" name="$ACTION_ID_abc" value="1"><input type="HIDDEN" name="csrf">
      <input type="text" name="ad"></form>`);
    expect(o.forms[0]?.fields.map(({ name }) => name)).toEqual(['ad']);
  });

  it('ad deseniyle süzmez: görünür alan adı $ACTION_ ile başlasa da kalır', async () => {
    const o = await ozet('<input type="text" name="$ACTION_gorunur">');
    expect(o.forms[0]?.fields.map(({ name }) => name)).toEqual(['$ACTION_gorunur']);
  });
});

describe('sayfaOzeti: etiket önceliği ve seçenekler (A3)', () => {
  it('her basamak: label[for] > aria-labelledby > aria-label > kapsayan label > placeholder', async () => {
    const o = await ozet(`
      <label for="i1">Birinci</label><input id="i1" name="n1" aria-labelledby="y1" aria-label="AriaX" placeholder="PhX">
      <span id="y1">Ikinci</span>
      <span id="y2">Üç</span><span id="y3">Sekiz</span>
      <input name="n2" aria-labelledby="y2 y3" aria-label="AriaX" placeholder="PhX">
      <input name="n3" aria-label="Ucuncu" placeholder="PhX">
      <label>Dorduncu <input name="n4" placeholder="PhX"></label>
      <input name="n5" placeholder="Besinci">
      <input name="n6">`);
    const etiket = (ad: string) => o.forms[0]?.fields.find(({ name }) => name === ad)?.label;
    expect(etiket('n1')).toBe('Birinci');
    expect(etiket('n2')).toBe('Üç Sekiz');
    expect(etiket('n3')).toBe('Ucuncu');
    expect(etiket('n4')).toBe('Dorduncu');
    expect(etiket('n5')).toBe('Besinci');
    expect(etiket('n6')).toBeUndefined();
  });

  it('label[for] form dışındaki etiketi de bulur (sayfa geneli)', async () => {
    const o = await ozet('<label for="s">Dışarıda</label><form><input id="s" name="s"></form>');
    expect(o.forms[0]?.fields[0]?.label).toBe('Dışarıda');
  });

  it('81 seçenekli select: etiket seçenek metni taşımaz, options 20, optionCount 81', async () => {
    const o = await ozet(`<label>Şehir <select name="sehir">${secenekler(81)}</select></label>
      <label for="s2">Hizmet</label><select id="s2" name="hizmet">${secenekler(3)}</select>`);
    const [sehir, hizmet] = o.forms[0]?.fields ?? [];
    expect(sehir?.label).toBe('Şehir');
    expect(sehir?.options).toHaveLength(20);
    expect(sehir?.options?.[0]).toBe('Seçenek 0');
    expect(sehir?.optionCount).toBe(81);
    expect(hizmet?.label).toBe('Hizmet');
    expect(JSON.stringify(sehir?.label)).not.toContain('Seçenek');
  });

  it('aynı label içindeki başka kontrolün seçenek metni etikete karışmaz', async () => {
    const o = await ozet(`<label>Ad <select name="s">${secenekler(3)}</select> <input name="i"></label>`);
    expect(o.forms[0]?.fields.find(({ name }) => name === 'i')?.label).toBe('Ad');
  });

  it('boş ve disabled seçenekler atlanır; select dışında options alanı yok', async () => {
    const o = await ozet(`<select name="s"><option value="">  </option><option disabled>Seçiniz</option>
      <option>A</option><option>B</option></select><input name="i">`);
    const [s, i] = o.forms[0]?.fields ?? [];
    expect(s?.options).toEqual(['A', 'B']);
    expect(s?.optionCount).toBe(2);
    expect(i).not.toHaveProperty('options');
    expect(i).not.toHaveProperty('optionCount');
  });
});

describe('sayfaOzeti: düğmeler (A4)', () => {
  it('yalnız aria-label taşıyan ikon düğmesi ve role=button span buttons içinde', async () => {
    const o = await ozet(`<button aria-label="Ara"><svg width="4" height="4"></svg></button>
      <span role="button" aria-label="Kapat"></span><span role="button">Menü</span>`);
    expect(o.buttons).toEqual(['Ara', 'Kapat', 'Menü']);
  });

  // 0.8.0 (P2-2): sıra erişilebilir ad sırasıdır (getByRole bununla eşler); eskiden metin aria-label'dan önceydi.
  it('öncelik: aria-labelledby > aria-label > içerik/value > title; boş girmez', async () => {
    const o = await ozet(`<button aria-label="Z" title="T">Metin</button><button title="T2">Metin2</button>
      <button title="Baslik"></button><input type="submit" value="Gönder"><input type="button" aria-label="Aria" value="V">
      <span id="ad1">Bağlı</span><span id="ad2">ad</span><button aria-labelledby="ad1 ad2" aria-label="Q">X</button>
      <button></button><input type="button" value="">`);
    expect(o.buttons).toEqual(['Z', 'Metin2', 'Baslik', 'Gönder', 'Aria', 'Bağlı ad']);
  });

  it('CSS text-transform ada girmez: ekranda CREATE, haritada Create; ad Playwright erişilebilir adıyla aynı', async () => {
    const o = await ozet(`<style>.b{text-transform:uppercase}.k{text-transform:lowercase}</style>
      <button class="b">Create</button><button class="k">Add Task</button>
      <button class="b"><span class="icon" aria-hidden="true">+</span><span>New</span><div>project</div></button>
      <button>Save<span style="display:none">x</span><span style="visibility:hidden">y</span><img alt="now"></button>`);
    expect(await sayfa.locator('button.b').first().innerText()).toBe('CREATE');
    expect(o.buttons).toEqual(['Create', 'Add Task', 'New project', 'Save now']);
    for (const ad of o.buttons) {
      expect(await sayfa.getByRole('button', { name: ad, exact: true }).count()).toBe(1);
    }
  });

  // Codex 2. tur P1-2: gizli metin haritaya girmez kuralı aria-labelledby hedefinin kendisine de işler.
  it('aria-labelledby hedefi gizliyse (hidden, display:none, aria-hidden) metni ada girmez', async () => {
    const o = await ozet(`<span id="g1" hidden>gizli-jeton-1</span><button aria-labelledby="g1">Bir</button>
      <span id="g2" style="display:none">gizli-jeton-2</span><button aria-labelledby="g2" aria-label="Iki">x</button>
      <span id="g3" aria-hidden="true">gizli-jeton-3</span><button aria-labelledby="g3">Uc</button>
      <div aria-hidden="true"><span id="g4">gizli-jeton-4</span></div><button aria-labelledby="g4">Dort</button>
      <span id="a5">Acik</span><button aria-labelledby="g1 a5">Bes</button>`);
    expect(o.buttons).toEqual(['Bir', 'Iki', 'Uc', 'Dort', 'Acik']);
    expect(JSON.stringify(o)).not.toContain('gizli-jeton');
  });

  it('devre dışı düğmeler disabledButtons içinde; buttons yine hepsini taşır; hiç yoksa alan yok', async () => {
    const o = await ozet(`<button disabled>Create</button><button>Cancel</button>
      <span role="button" aria-disabled="true">Archive</span><fieldset disabled><button>Inside</button></fieldset>
      <input type="submit" value="Send" disabled><button disabled>Twin</button><button>Twin</button>`);
    expect(o.buttons).toEqual(['Create', 'Cancel', 'Archive', 'Inside', 'Send', 'Twin']);
    expect(o.disabledButtons).toEqual(['Create', 'Archive', 'Inside', 'Send']);
    expect(await ozet('<button>Ok</button>')).not.toHaveProperty('disabledButtons');
  });

  it('düğme tavanı 50', async () => {
    const o = await ozet(Array.from({ length: 70 }, (_, i) => `<button>D${i}</button>`).join(''));
    expect(o.buttons).toHaveLength(50);
  });
});

describe('sayfaOzeti: disclosures (A5) ve tavanlar (A6)', () => {
  it('summary metinleri disclosures içinde ve details kapalı kalır', async () => {
    const o = await ozet('<details><summary>Fiyat dökümü</summary><input name="ic"></details><details><summary>SSS</summary>x</details>');
    expect(o.disclosures).toEqual(['Fiyat dökümü', 'SSS']);
    expect(await sayfa.locator('details[open]').count()).toBe(0);
    expect(o.forms[0]?.fields.map(({ name }) => name)).toEqual(['ic']);
  });

  it('disclosure yoksa alan hiç yazılmaz; tavan 20', async () => {
    expect(await ozet('<p>x</p>')).not.toHaveProperty('disclosures');
    const o = await ozet(Array.from({ length: 30 }, (_, i) => `<details><summary>S${i}</summary></details>`).join(''));
    expect(o.disclosures).toHaveLength(20);
  });

  it('sayfa başına alan tavanı 100', async () => {
    const o = await ozet(Array.from({ length: 130 }, (_, i) => `<input name="a${i}">`).join(''));
    expect(o.forms[0]?.fields).toHaveLength(100);
  });
});

describe('sayfaOzeti: alan etiketinde gizli metin (Codex 2. tur, etiketBul)', () => {
  it('gizli aria-labelledby hedefi, gizli label[for] ve etiketin gizli/aria-hidden parçası etikete girmez', async () => {
    const o = await ozet(`
      <span id="e1" hidden>gizli-etiket-1</span><input name="n1" aria-labelledby="e1" placeholder="Bir">
      <div aria-hidden="true"><span id="e2">gizli-etiket-2</span></div><input name="n2" aria-labelledby="e2" aria-label="Iki">
      <span id="e3" style="visibility:hidden">gizli-etiket-3</span><span id="a3">Uc</span><input name="n3" aria-labelledby="e3 a3">
      <label for="i4" hidden>gizli-etiket-4</label><label for="i4">Dort</label><input id="i4" name="n4">
      <label>Bes<span aria-hidden="true">gizli-etiket-5</span><span style="visibility:hidden">gizli-etiket-6</span> <input name="n5"></label>`);
    const etiket = (ad: string) => o.forms[0]?.fields.find(({ name }) => name === ad)?.label;
    expect([etiket('n1'), etiket('n2'), etiket('n3'), etiket('n4'), etiket('n5')]).toEqual(['Bir', 'Iki', 'Uc', 'Dort', 'Bes']);
    expect(JSON.stringify(o)).not.toContain('gizli-etiket');
  });
});

describe('sayfaOzeti: opacity:0 ve gölge kökü (Codex 3. tur b)', () => {
  it('opacity:0 hedef/parça ve aria-hidden host içindeki gölge hedefi düğme adına ve etikete girmez', async () => {
    const o = await ozet(`
      <span id="o1" style="opacity:0">gizli-opak-1</span><button aria-labelledby="o1">Bir</button>
      <button>Iki<span style="opacity:0">gizli-opak-2</span></button>
      <span id="o3" style="opacity:0">gizli-opak-3</span><input name="n3" aria-labelledby="o3" placeholder="Uc">
      <label>Alti<span style="opacity:0">gizli-opak-6</span> <input name="n6"></label>
      <div id="h" aria-hidden="true"></div><script>
        document.getElementById('h').attachShadow({ mode: 'open' }).innerHTML =
          '<span id="s4">gizli-golge-4</span><input name="n4" aria-labelledby="s4" placeholder="Dort">'
          + '<button aria-labelledby="s4">Bes</button>';
      </script>`);
    const etiket = (ad: string) => o.forms.flatMap((f) => f.fields).find(({ name }) => name === ad)?.label;
    // Kör kabul 5a: aria-hidden host içindeki düğmenin kendisi de gizlidir, ad vermez.
    expect(o.buttons).toEqual(['Bir', 'Iki']);
    expect([etiket('n3'), etiket('n4'), etiket('n6')]).toEqual(['Uc', 'Dort', 'Alti']);
    expect(JSON.stringify(o)).not.toMatch(/gizli-(opak|golge)/);
  });

  // Vikunja: kenar çubuğundaki "Mark this project as favorite" üzerine gelince beliren düğmedir.
  it('opacity:0 kapsayıcı içindeki (üzerine gelince beliren) düğmenin adı kalır; erişilebilir adla aynı', async () => {
    const o = await ozet(`<div style="opacity:0"><button><span class="sr">Favori yap</span></button></div>
      <button style="opacity:0">Belir</button>`);
    expect(o.buttons).toEqual(['Favori yap', 'Belir']);
    for (const ad of o.buttons) expect(await sayfa.getByRole('button', { name: ad, exact: true }).count()).toBe(1);
  });
});

describe('sayfaOzeti: kör kabul 5', () => {
  it('(a) gizli düğmenin kendisi ad vermez; opacity:0 düğme (üzerine gelince beliren) kalır', async () => {
    const o = await ozet(`<div hidden><button>gizli-dugme-1</button></div>
      <button style="display:none">gizli-dugme-2</button><button aria-label="gizli-dugme-3" style="visibility:hidden">x</button>
      <div aria-hidden="true"><button>gizli-dugme-4</button></div><button style="opacity:0">Belir</button><button>Acik</button>`);
    expect(o.buttons).toEqual(['Belir', 'Acik']);
    expect(JSON.stringify(o)).not.toContain('gizli-dugme');
  });

  it('(b) aria-hidden değeri büyük/küçük harf ve boşluk duyarsız: "TRUE", " true " gizlidir', async () => {
    const o = await ozet(`<button>Bir<span aria-hidden="TRUE">gizli-ah-1</span></button>
      <span id="r2" aria-hidden=" true ">gizli-ah-2</span><input name="n2" aria-labelledby="r2" placeholder="Iki">
      <label>Uc<span aria-hidden="True">gizli-ah-3</span> <input name="n3"></label>`);
    expect(o.buttons).toEqual(['Bir']);
    expect(o.forms[0]?.fields.map((alan) => alan.label)).toEqual(['Iki', 'Uc']);
    expect(JSON.stringify(o)).not.toContain('gizli-ah');
  });
});

describe('HaritaSemasi: disabledButtons (kör kabul 4)', () => {
  it('disabledButtons taşıyan harita şemadan geçerken alan korunur; alansız eski harita da geçer', () => {
    const sayfa = { url: 'http://u.test/', title: '', headings: [], links: [], forms: [], buttons: ['Create', 'Cancel'], menu: [] };
    const harita = (ek: object) => ({ baseUrl: 'http://u.test', loggedIn: false, exploredAt: '2026-11-08T00:00:00.000Z', pages: [{ ...sayfa, ...ek }] });
    expect(v.parse(HaritaSemasi, harita({ disabledButtons: ['Create'] })).pages[0]?.disabledButtons).toEqual(['Create']);
    expect(v.parse(HaritaSemasi, harita({})).pages[0]).not.toHaveProperty('disabledButtons');
  });
});

describe('sayfaOzeti: kullanılamaz seçenek ve gizli metin', () => {
  it('disabled optgroup içindeki seçenekler options ve optionCount dışında', async () => {
    const o = await ozet(`<select name="s"><optgroup disabled label="G"><option>a</option><option>b</option></optgroup>
      <option>c</option><option>d</option><option>e</option></select>`);
    expect(o.forms[0]?.fields[0]?.options).toEqual(['c', 'd', 'e']);
    expect(o.forms[0]?.fields[0]?.optionCount).toBe(3);
  });

  it('gizli iç metin düğme adına ve etikete girmez, haritada hiçbir yerde geçmez', async () => {
    const o = await ozet(`<button>Kaydet<span hidden>gizli-jeton</span></button>
      <label>Ad<span hidden>gizli-jeton</span> <input name="i"></label>`);
    expect(o.buttons).toEqual(['Kaydet']);
    expect(o.forms[0]?.fields[0]?.label).toBe('Ad');
    expect(JSON.stringify(o)).not.toContain('gizli-jeton');
  });
});

describe('sayfaOzeti: shadow DOM', () => {
  it('açık shadow kökündeki form, alan, düğme, disclosure ve link okunur', async () => {
    const o = await ozet(`<div id="k"></div><script>
      const kok = document.getElementById('k').attachShadow({ mode: 'open' });
      kok.innerHTML = '<label for="s">Gölge ad</label><form action="/g"><input id="s" name="golge"></form>'
        + '<a href="http://uygulama.test/golge-link">g</a><button>Gölge düğme</button>'
        + '<details><summary>Gölge özet</summary></details>';
    </script>`);
    expect(o.forms).toHaveLength(1);
    expect(o.forms[0]?.action).toBe('/g');
    expect(o.forms[0]?.fields).toEqual([{ name: 'golge', type: 'input', label: 'Gölge ad' }]);
    expect(o.links).toContain('http://uygulama.test/golge-link');
    expect(o.buttons).toEqual(['Gölge düğme']);
    expect(o.disclosures).toEqual(['Gölge özet']);
  });

  it('kapalı shadow kökündeki alan haritada yok', async () => {
    const o = await ozet(`<div id="k"></div><input name="dis"><script>
      const kok = document.getElementById('k').attachShadow({ mode: 'closed' });
      kok.innerHTML = '<input name="kapali"><button>Kapalı düğme</button>';
    </script>`);
    expect(o.forms[0]?.fields.map(({ name }) => name)).toEqual(['dis']);
    expect(o.buttons).toEqual([]);
  });
});

describe('sayfaOzeti: başlık, menü, seçenek, disclosure erişilebilir ad kuralıyla (0.8.0 P2-2)', () => {
  it('gizli h1 haritaya girmez; aria-label kazanır (Vikunja kalıbı)', async () => {
    const o = await ozet(`
      <h1 class="project-title-print" style="display:none">Home renovation</h1>
      <h1 aria-label="Title">Görünen metin</h1>
      <h2 aria-hidden="true">Gizli alt</h2><h2>Tasks</h2>`);
    expect(o.headings).toEqual(['Title', 'Tasks']);
    expect(o.headings).not.toContain('Home renovation');
  });

  it('menü bağlantısı: gizli olan düşer, aria-label kazanır', async () => {
    const o = await ozet(`<nav><a href="/a" aria-label="Projects">P</a><a href="/b" style="display:none">Gizli</a><a href="/c">Labels</a></nav>`);
    expect(o.menu).toEqual(['Projects', 'Labels']);
  });

  it('gizli seçenek ve gizli summary haritaya girmez; summary aria-label alır', async () => {
    const o = await ozet(`
      <select name="s"><option>A</option><option style="display:none">B</option><option>C</option></select>
      <details><summary aria-label="More options">x</summary></details>
      <details><summary style="display:none">Gizli</summary></details>`);
    expect(o.forms[0]?.fields[0]?.options).toEqual(['A', 'C']);
    expect(o.disclosures).toEqual(['More options']);
  });
});

describe('sayfaOzeti: seçenek adı ve gizli üst öğe (0.8.0 P2-2)', () => {
  it('option aria-label metnin önüne geçer', async () => {
    const o = await ozet('<select name="s"><option aria-label="Alpha">a</option><option>B</option></select>');
    expect(o.forms[0]?.fields[0]?.options).toEqual(['Alpha', 'B']);
  });
  it('gizli select, optgroup ve atanın seçenekleri düşer', async () => {
    const o = await ozet(`
      <select name="a" style="display:none"><option>A1</option></select>
      <select name="b" style="visibility:hidden"><option>B1</option></select>
      <select name="c" hidden><option>C1</option></select>
      <select name="d" aria-hidden="true"><option>D1</option></select>
      <select name="e"><optgroup label="g" style="display:none"><option>E1</option></optgroup><option>E2</option></select>
      <div style="display:none"><select name="f"><option>F1</option></select></div>`);
    const secenekler = Object.fromEntries((o.forms[0]?.fields ?? []).map((f) => [f.name, f.options]));
    expect(secenekler).toEqual({ a: [], b: [], c: [], d: [], e: ['E2'], f: [] });
  });
});

describe('sayfaMetinleriniGizle: devre dışı düğmeler', () => {
  it('disabledButtons da serbest metin gibi maskelenir; alan yoksa eklenmez', () => {
    const maske = { metin: (deger: string) => deger.replaceAll('gizli', '[redacted]'), yapisalDusur: () => false };
    const temel = { url: 'http://uygulama.test/', title: '', headings: [], links: [], forms: [], menu: [] };
    const sonuc = sayfaMetinleriniGizle({ ...temel, buttons: ['Use gizli'], disabledButtons: ['Use gizli'] }, maske);
    expect(sonuc.disabledButtons).toEqual(['Use [redacted]']);
    expect(sayfaMetinleriniGizle({ ...temel, buttons: ['Ok'] }, maske)).not.toHaveProperty('disabledButtons');
  });
});
