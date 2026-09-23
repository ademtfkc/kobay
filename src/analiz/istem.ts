import type { AdimSonucu, HaritaFarki, TestKaydi } from '../depo/index.js';

/** Beynin serbest metin alanlarını hangi dilde yazacağını söyleyen ortak cümle. */
export const DIL_KURALI = 'Write names, descriptions and rationale in the language of the '
  + "application's UI and docs; if mixed or unclear, use English.";

export interface AnalizIstemBaglami {
  dusenAdim: AdimSonucu;
  hataMetni: string;
  ekranGoruntusu: { varMi: boolean; yol: string };
  dom: string | null;
  konsolHatalari: Array<{ tip: 'error' | 'warning'; metin: string; stepIndex?: number }>;
  agHatalari: Array<{ url: string; method: string; status?: number; hata?: string; stepIndex?: number }>;
  kod: string;
  test: TestKaydi;
  mapDiff?: HaritaFarki;
}

export function analizSistemIstemiOlustur(): string {
  return `You are a root cause analyst for browser test failures. Rely only on the evidence given; follow the JSON schema exactly.

Return only an object matching this exact JSON skeleton:
{"rootCauseHypothesis":"...","failureKind":"test_bug","recommendedFixTarget":{"kind":"selector","reference":"...","rationale":"..."},"evidence":[{"kind":"snapshot","stepIndex":0,"summary":"..."}]}

The keys rootCauseHypothesis, failureKind, recommendedFixTarget, kind, reference, rationale, evidence, stepIndex and summary are English and fixed; do not translate them. Only the text values may be in another language.
${DIL_KURALI}
failureKind can only be product_bug, product_changed, test_bug, env, flaky or unknown.
Do not use Kobay's internal JSON field names (for example pageIdentityMatches, changed, addedHeadings) in the text values; explain the finding in plain words.

failureKind rules:
- If the element the test looks for exists in the exploration map but not in the current DOM, and a new element doing a similar job took its place (a rename; an added heading/button facing a removed heading/button): product_changed; recommendedFixTarget.kind: code. reference must show the page URL and the old → new element. rationale must say that the exploration went stale and that exploration has to be refreshed and the test regenerated. Do not confuse this with test_bug.
- If the element was removed and nothing replaced it (the diff block has removals but no additions) this is NOT product_changed: the product may have been broken by accident, consider product_bug.
- If pageIdentityMatches is false in the diff block against the exploration map, the page is no longer the page from the exploration (the session may have dropped, it may have been redirected to the login screen): do not say product_changed; consider env or unknown.
- Selector not found and a similar element exists in the DOM: test_bug; recommendedFixTarget.kind: selector. reference must show the line or the selector in the test code.
- If the target returned 5xx, a network error or a timeout: env; recommendedFixTarget.kind: env.
- If the element is in the DOM but the assertion text does not match: product_bug; recommendedFixTarget.kind: code. reference must describe the page URL and the element involved.
- When recommendedFixTarget.kind is code and failureKind is product_bug, rationale must hint at searching the product code for the unexpected Received value/text from the error message in order to find the source file.
- If the evidence is not enough: unknown; recommendedFixTarget.kind: unknown.

evidence must have at most 6 items. Every item must carry only kind, stepIndex and a short summary; do not write file paths.
evidence.kind can only be screenshot, snapshot, console, network or log; do not use other values such as dom, diff or error (use snapshot for a DOM observation, log for an error message, snapshot for a map diff).`;
}

function jsonBlok(baslik: string, veri: unknown): string {
  return `## ${baslik}\n${JSON.stringify(veri, null, 2)}`;
}

/** Beyne taşınacak hata bağlamını kurar; konsol ve ağ kayıtlarını 20'şer adetle sınırlar. */
export function analizKullaniciIstemiOlustur(baglam: AnalizIstemBaglami): string {
  return [
    '# Failed test analysis',
    jsonBlok('Test', { id: baglam.test.id, name: baglam.test.name, url: baglam.test.url ?? null }),
    jsonBlok('Failed step', baglam.dusenAdim),
    `## Error message\n${baglam.hataMetni}`,
    jsonBlok('Screenshot', { exists: baglam.ekranGoruntusu.varMi, path: baglam.ekranGoruntusu.yol }),
    `## Cleaned DOM\n${baglam.dom ?? '[no DOM file]'}`,
    baglam.mapDiff === undefined
      ? '## Diff against the exploration map\n[no map diff]'
      : [
        jsonBlok('Diff against the exploration map', baglam.mapDiff),
        baglam.mapDiff.pageIdentityMatches
          ? 'pageIdentityMatches true: the DOM still shows the page from the exploration.'
          : 'pageIdentityMatches false: the DOM is not the page from the exploration (for example the session dropped, or it was redirected to the login screen). Do not say product_changed; consider env or unknown.',
      ].join('\n'),
    jsonBlok('Console errors (at most 20)', baglam.konsolHatalari.slice(0, 20).map((kayit) => ({
      type: kayit.tip,
      text: kayit.metin,
      ...(kayit.stepIndex === undefined ? {} : { stepIndex: kayit.stepIndex }),
    }))),
    jsonBlok('Network errors (at most 20)', baglam.agHatalari.slice(0, 20).map((kayit) => ({
      url: kayit.url,
      method: kayit.method,
      ...(kayit.status === undefined ? {} : { status: kayit.status }),
      ...(kayit.hata === undefined ? {} : { error: kayit.hata }),
      ...(kayit.stepIndex === undefined ? {} : { stepIndex: kayit.stepIndex }),
    }))),
    `## Test code\n${baglam.kod || '[no test code]'}`,
    jsonBlok('Plan steps', baglam.test.planSteps),
  ].join('\n\n');
}
