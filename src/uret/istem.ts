import type { Harita, TestKaydi } from '../depo/index.js';

/** Beynin serbest metin alanlarını hangi dilde yazacağını söyleyen ortak cümle. */
export const DIL_KURALI = 'Write names, descriptions and rationale in the language of the '
  + "application's UI and docs; if mixed or unclear, use English.";

export function sistemIstemi(): string {
  return [
    'You are an experienced Playwright test author.',
    "Return only an object matching this exact JSON skeleton: {\"code\": \"...\", \"explanation\": \"...\"}.",
    "Full example: {\"code\": \"import { test, expect } from './_fixture';\\n\\ntest('Products are visible', async ({ page }) => {\\n  await test.step('0: Open the products page', async () => { await page.goto('/products'); });\\n});\", \"explanation\": \"A single test that opens the products page.\"}",
    'The keys code and explanation are the schema\'s fixed keys; do not translate them. Only the text values may be in another language.',
    DIL_KURALI,
    "The first line of the code must be exactly import { test, expect } from './_fixture'; do not use any other import.",
    "Write exactly one test: test('<test name>', async ({ page }) => { ... }).",
    "For every plan step write an await test.step('N: description', async () => { ... }) whose index starts at 0 and whose description is copied verbatim.",
    'If a step description contains an apostrophe, use double quotes or a backtick; you may also escape the quotes.',
    'The page arrives already logged in; do not fill a login form and do not type a user name or a password.',
    'Prefer getByRole in selectors; then getByLabel, getByPlaceholder, getByText, and CSS last.',
    "Use { exact: true } in a getByRole name for an exact match; one text may be a substring of another element (for example 'Customers' inside 'Dormant customers'), and a loose match raises a strict mode violation. An element's accessible name also covers nested elements (for example <h2>Invoice list<span>4 records</span></h2>): for such headings give name a regular expression (name: /^Invoice list/) and verify the content with toContainText. In getByText prefer a narrow regular expression over exact; do not write exact: true when you do not know the exact text in the DOM.",
    'Do not use page.waitForTimeout. page.goto may only visit one of the URL paths given in the map.',
    'The code deny list is only a speed bump, not a security boundary; do not try to reach Node process, file system or network APIs.',
  ].join('\n');
}

export function kullaniciIstemi(test: TestKaydi, harita: Harita, oncekiHata?: string): string {
  const sayfalar = harita.pages.map((sayfa) => ({
    url: sayfa.url,
    title: sayfa.title,
    headings: sayfa.headings,
    forms: sayfa.forms,
    buttons: sayfa.buttons,
    links: sayfa.links,
  }));
  const geriBildirim = oncekiHata === undefined
    ? ''
    : `\n\nThe previous attempt was rejected: ${oncekiHata}\nFix this error and produce new code.`;
  return [
    `Test name: ${test.name}`,
    `Plan steps: ${JSON.stringify(test.planSteps)}`,
    `Map base URL: ${harita.baseUrl}`,
    `Pages in the map: ${JSON.stringify(sayfalar)}`,
    geriBildirim,
  ].join('\n');
}
