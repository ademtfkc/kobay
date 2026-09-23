import type { Harita, TestKaydi } from '../depo/index.js';

export function sistemIstemi(): string {
  return [
    'Sen deneyimli bir Playwright test yazarısın.',
    "Yalnız şu tam JSON iskeletine uyan bir nesne döndür: {\"kod\": \"...\", \"aciklama\": \"...\"}.",
    "Tam örnek: {\"kod\": \"import { test, expect } from './_fixture';\\n\\ntest('Ürünler görünür', async ({ page }) => {\\n  await test.step('0: Ürünler sayfasını aç', async () => { await page.goto('/urunler'); });\\n});\", \"aciklama\": \"Ürün sayfasını açan tek test.\"}",
    'kod ve aciklama anahtarları şemanın değişmez anahtarlarıdır; bunları çevirme. Türkçe yalnız metin değerlerinde kalabilir.',
    "Kodun ilk satırı tam olarak import { test, expect } from './_fixture'; olmalı; başka import kullanma.",
    "Tam olarak tek test yaz: test('<test adı>', async ({ page }) => { ... }).",
    "Her plan adımı için sırası 0'dan başlayan, birebir açıklamalı await test.step('N: açıklama', async () => { ... }) yaz.",
    'Adım açıklamasında tırnak varsa çift tırnak veya backtick kullan; tırnakları kaçışlayarak da yazabilirsin.',
    'Sayfa zaten giriş yapılmış gelir; giriş formu doldurma, kullanıcı adı ya da parola yazma.',
    'Seçicide getByRole önceliklidir; sonra getByLabel, getByPlaceholder, getByText, en son CSS kullan.',
    "getByRole name'inde tam eşleşme için { exact: true } kullan; bir metin başka öğenin alt dizesi olabilir (ör. 'Müşteriler' ile 'Sessizleşen müşteriler'), gevşek eşleşme strict mode ihlali verir. Öğenin erişilebilir adı iç içe öğeleri de kapsar (ör. <h2>Fatura listesi<span>4 kayıt</span></h2>): böyle başlıklarda name'e regex ver (name: /^Fatura listesi/) ve içeriği toContainText ile doğrula. getByText'te exact yerine sınırlı regex tercih et; DOM'da tam metni bilmiyorsan exact: true yazma.",
    'page.waitForTimeout kullanma. page.goto yalnız verilen harita URL yollarından birine gidebilir.',
    'Kod red listesi yalnız hız kesicidir, güvenlik sınırı değildir; Node süreç/dosya/ağ API’lerine erişmeye çalışma.',
  ].join('\n');
}

export function kullaniciIstemi(test: TestKaydi, harita: Harita, oncekiHata?: string): string {
  const sayfalar = harita.sayfalar.map((sayfa) => ({
    url: sayfa.url,
    baslik: sayfa.baslik,
    basliklar: sayfa.basliklar,
    formlar: sayfa.formlar,
    dugmeler: sayfa.dugmeler,
    linkler: sayfa.linkler,
  }));
  const geriBildirim = oncekiHata === undefined ? '' : `\n\nÖnceki deneme reddedildi: ${oncekiHata}\nBu hatayı düzelterek yeni kod üret.`;
  return [
    `Test adı: ${test.name}`,
    `Plan adımları: ${JSON.stringify(test.planSteps)}`,
    `Harita base URL: ${harita.baseUrl}`,
    `Haritadaki sayfalar: ${JSON.stringify(sayfalar)}`,
    geriBildirim,
  ].join('\n');
}
