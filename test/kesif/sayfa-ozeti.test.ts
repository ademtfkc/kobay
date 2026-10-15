import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sayfaOzeti } from '../../src/kesif/sayfa-ozeti.js';

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

  it('öncelik: görünür metin > aria-label > title > value; boş girmez', async () => {
    const o = await ozet(`<button aria-label="Z" title="T">Metin</button>
      <button title="Baslik"></button><input type="submit" value="Gönder"><input type="button" aria-label="Aria" value="V">
      <button></button><input type="button" value="">`);
    expect(o.buttons).toEqual(['Metin', 'Baslik', 'Gönder', 'Aria']);
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
