import type { Form, FormAlani, Harita, HaritaFarki, PlanAdimi, Sayfa, TestKaydi } from '../depo/index.js';

const BELGE_SINIRI = 20_000;
const ISTEM_SINIRI = 60_000;
const HARITA_SINIRI = 35_000;
const SAYFA_SINIRI = 2_000;

/** Beynin serbest metin alanlarını hangi dilde yazacağını söyleyen ortak cümle. */
export const DIL_KURALI = 'Write names, descriptions and rationale in the language of the '
  + "application's UI and docs; if mixed or unclear, use English.";

export const PLAN_SISTEM_ISTEMI = `You are a QA planner. Act like an experienced QA test planner.

Produce 8-25 proposals. Every proposal must be a real user flow: bind it through url to a real page in the map; steps must have 2-15 steps, mix action and assertion, and contain at least one assertion. In the priority spread use p0 for critical flows (login, the main transaction), p1 for important, p2 for secondary and p3 for cosmetic ones. category is a category such as login, form, navigation, data, permission or error-case; feature is a short name.

Record URLs that match a path pattern in the map but do not exist (for example /customers/999999 when the map contains /customers/36) may be proposed as error-case tests; those are accepted.

Propose destructive operations such as delete and logout only when they are explicitly reversible. Do not propose things that cannot be tested, such as sending e-mail or calling an external service.

Return only an object matching the JSON skeleton below. Do not send proposalId; the system assigns it locally:
{"proposals":[{"title":"...","description":"...","priority":"p1","category":"...","feature":"...","type":"frontend","url":"/example","steps":[{"type":"action","description":"..."},{"type":"assertion","description":"..."}]}]}

Full example:
{"proposals":[{"title":"View the product list","description":"Verifies that the user opens the products page and sees the list.","priority":"p1","category":"navigation","feature":"products","type":"frontend","url":"/products","steps":[{"type":"action","description":"Open the products page"},{"type":"assertion","description":"Verify that the product list is visible"}]}]}

The keys title, description, priority, category, feature, type, url and the type and description keys inside steps are English and fixed; do not translate them into any other language. Only the text values may be in another language.
${DIL_KURALI}`;

function metniKes(metin: string, sinir: number): string {
  return metin.length <= sinir ? metin : `${metin.slice(0, sinir)}…[truncated]`;
}

function listeOzeti(degerler: string[], ogeSiniri = 12, ogeKarakterSiniri = 140): string {
  const ozet = degerler.slice(0, ogeSiniri).map((deger) => metniKes(deger, ogeKarakterSiniri));
  const kalan = degerler.length - ozet.length;
  return kalan > 0 ? `${ozet.join(' | ')} | +${kalan}` : ozet.join(' | ');
}

function alanOzeti(alan: FormAlani): string {
  const etiket = alan.label === undefined ? '' : `, label: ${metniKes(alan.label, 100)}`;
  const placeholder = alan.placeholder === undefined ? '' : `, placeholder: ${metniKes(alan.placeholder, 100)}`;
  return `${metniKes(alan.name, 100)} (${metniKes(alan.type, 60)}${etiket}${placeholder})`;
}

function formOzeti(form: Form): string {
  const action = form.action === undefined ? '' : ` action=${metniKes(form.action, 160)}`;
  return `[${form.fields.slice(0, 16).map(alanOzeti).join('; ')}]${action}`;
}

function sayfaOzeti(sayfa: Sayfa): string {
  const metin = [
    `url: ${metniKes(sayfa.url, 500)}`,
    `title: ${metniKes(sayfa.title, 300)}`,
    `h1-h3: ${listeOzeti(sayfa.headings)}`,
    `form fields: ${sayfa.forms.slice(0, 8).map(formOzeti).join(' | ')}`,
    `buttons: ${listeOzeti(sayfa.buttons)}`,
    `menu: ${listeOzeti(sayfa.menu)}`,
  ].join('\n');
  return metniKes(metin, SAYFA_SINIRI);
}

function haritaOzeti(harita: Harita): string {
  let kalan = HARITA_SINIRI;
  const sayfalar: string[] = [];
  for (const [sira, sayfa] of harita.pages.slice(0, 40).entries()) {
    const ozet = `Page ${sira + 1}\n${sayfaOzeti(sayfa)}`;
    if (ozet.length > kalan) {
      if (kalan > 0) sayfalar.push(metniKes(ozet, kalan));
      sayfalar.push('…[map truncated]');
      break;
    }
    sayfalar.push(ozet);
    kalan -= ozet.length;
  }
  return `Base URL: ${harita.baseUrl}\nLogged in: ${harita.loggedIn ? 'yes' : 'no'}\n\n${sayfalar.join('\n\n')}`;
}

/** Plan beyni için kullanıcı istemini kurar; birim testlerinde doğrudan kullanılabilir. */
export function planKullaniciIstemiOlustur(harita: Harita, belge: string | undefined, ipucu?: string): string {
  const belgeMetni = belge === undefined
    ? 'No document provided.'
    : metniKes(belge, BELGE_SINIRI);
  const ipucuBolumu = ipucu === undefined || ipucu === ''
    ? ''
    : `\n\n## User hint\n${metniKes(ipucu, 2_000)}`;
  const istem = `## Application map\n${haritaOzeti(harita)}\n\n## Project document\n${belgeMetni}${ipucuBolumu}`;
  return metniKes(istem, ISTEM_SINIRI);
}

export const PLAN_YENILEME_SISTEM_ISTEMI = `You are a QA planner. A test plan went stale because the target page was renamed. Your job is not to rewrite the test but to adapt the existing steps to the new interface.

Rules:
- DO NOT change the number of steps. Return exactly as many steps as you were given.
- Preserve the order and the intent of the steps: every step must be the counterpart that does the same job as the old one. An action stays an action, an assertion stays an assertion.
- Update only the renamed elements: headings, buttons, menu entries or form labels that existed on the old page and now appear under a different name must be written with their new names.
- Do NOT add new steps, new assertions or new flows; do not drop an old step either.
- If an element has no counterpart on the new page, leave the step as close as possible; do not invent elements.
- The name field is the test's name: update it if it mentions a renamed element, otherwise return it unchanged.

Return only an object matching the JSON skeleton below:
{"name":"...","steps":[{"type":"action","description":"..."},{"type":"assertion","description":"..."}]}

Full example (the old steps mentioned "Accounts", the new page says "Customers"):
{"name":"View the customer list","steps":[{"type":"action","description":"Open the customers page"},{"type":"assertion","description":"Verify that the Customers heading is visible"}]}

The keys name, steps and the type and description keys inside steps are English and fixed; do not translate them into any other language. Only the text values may be in another language.
${DIL_KURALI}`;

function adimListesi(adimlar: readonly PlanAdimi[]): string {
  return adimlar
    .map((adim, sira) => `${sira}. [${adim.type}] ${metniKes(adim.description, 500)}`)
    .join('\n');
}

function haritaFarkiOzeti(fark: HaritaFarki): string {
  return [
    `url: ${metniKes(fark.url, 500)}`,
    `removed headings: ${listeOzeti(fark.removedHeadings)}`,
    `added headings: ${listeOzeti(fark.addedHeadings)}`,
    `removed buttons: ${listeOzeti(fark.removedButtons)}`,
    `added buttons: ${listeOzeti(fark.addedButtons)}`,
    `removed form fields: ${listeOzeti(fark.removedFormFields)}`,
    `added form fields: ${listeOzeti(fark.addedFormFields)}`,
  ].join('\n');
}

export interface PlanYenilemeIstemBaglami {
  test: Pick<TestKaydi, 'name' | 'planSteps'>;
  eskiSayfa?: Sayfa;
  yeniSayfa: Sayfa;
  mapDiff?: HaritaFarki;
}

/** Plan yenileme beyni için kullanıcı istemini kurar; birim testlerinde doğrudan kullanılabilir. */
export function planYenilemeKullaniciIstemiOlustur(baglam: PlanYenilemeIstemBaglami): string {
  const bolumler = [
    `## Test name\n${metniKes(baglam.test.name, 300)}`,
    `## Previous plan steps (${baglam.test.planSteps.length} steps — this count must be preserved)\n${adimListesi(baglam.test.planSteps)}`,
    `## The page as it was (from the exploration map)\n${baglam.eskiSayfa === undefined ? 'No previous summary.' : sayfaOzeti(baglam.eskiSayfa)}`,
    `## The page as it is now (just explored)\n${sayfaOzeti(baglam.yeniSayfa)}`,
    `## Map diff from the latest failure bundle\n${baglam.mapDiff === undefined ? 'No diff information.' : haritaFarkiOzeti(baglam.mapDiff)}`,
  ];
  return metniKes(bolumler.join('\n\n'), ISTEM_SINIRI);
}
