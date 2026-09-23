import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BeyinHatasi, beyinOlustur } from '../../src/beyin/index.js';
import {
  BeyinButcesi,
  eksikKapanislariTamamla,
  ilkJsonBlogu,
  VARSAYILAN_CLAUDE_BUTCESI_USD,
} from '../../src/beyin/ortak.js';

const sema = v.object({ tamam: v.boolean() });
const cliDizini = resolve('test/sahte-cli');
const anahtarliOrtam = process.env.PATH === undefined ? cliDizini : `${cliDizini}:${process.env.PATH}`;
const geciciler: string[] = [];

async function geciciDizin(): Promise<string> {
  const dizin = await mkdtemp(join(tmpdir(), 'kobay-beyin-'));
  geciciler.push(dizin);
  return dizin;
}

async function ciktiDosyasi(icerik: string): Promise<string> {
  const yol = join(await geciciDizin(), 'cikti.json');
  await writeFile(yol, icerik);
  return yol;
}

function ortam(ek: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { PATH: anahtarliOrtam, ...ek };
}

/** Gerçek OpenRouter yanıtındaki gibi `pricing.request` alanı YOK. */
function fiyatYaniti(prompt = '0.000001', completion = '0.000002'): Response {
  return new Response(JSON.stringify({ data: { pricing: { prompt, completion } } }), { status: 200 });
}

/**
 * GET https://openrouter.ai/api/v1/model/google/gemini-3.8-flash (21 Eyl 2026, ücretsiz uç) yanıtından
 * kırpılmış gerçek örnek. /api/v1/models listesindeki 443 modelin hiçbirinde `pricing.request` yoktu.
 */
const GERCEK_OPENROUTER_MODEL_YANITI = {
  data: {
    id: 'google/gemini-3.8-flash',
    canonical_slug: 'google/gemini-3.8-flash-20260902',
    name: 'Google: Gemini 3.8 Flash',
    context_length: 1048576,
    pricing: {
      prompt: '0.00000075',
      completion: '0.00000375',
      image: '0.00000075',
      audio: '0.00000075',
      input_audio_cache: '0.000000075',
      web_search: '0.014',
      internal_reasoning: '0.00000375',
      input_cache_read: '0.000000075',
      input_cache_write: '0.0000000416666666666667',
    },
    top_provider: { context_length: 1048576, max_completion_tokens: 65536, is_moderated: false },
    per_request_limits: null,
  },
};

/**
 * Çağrı sayısını dosyaya yazan, stdout/çıkış kodu/bekleme süresi ortamdan gelen sahte CLI.
 *
 * Çağrı, süreç doğar doğmaz kaydedilir. Eskiden kayıt stdin `end` olayında
 * atılıyordu; zaman aşımı testinde SIGTERM stdin bitmeden gelince çağrı hiç
 * sayılmıyor ve test makinenin süreç açma hızına göre rastgele düşüyordu.
 */
async function sahteCliDizini(ad: 'claude' | 'codex'): Promise<{ path: string; sayac: string }> {
  const dizin = await geciciDizin();
  const sayac = join(dizin, 'cagrilar.txt');
  await writeFile(join(dizin, ad), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(sayac)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdin.resume();
process.stdin.on('end', async () => {
  const bekle = Number(process.env.T_BEKLE_MS ?? '0');
  if (bekle > 0) await new Promise((coz) => setTimeout(coz, bekle));
  process.stdout.write(process.env.T_CIKTI ?? '');
  process.exitCode = Number(process.env.T_KOD ?? '0');
});
`);
  await chmod(join(dizin, ad), 0o755);
  return { path: process.env.PATH === undefined ? dizin : `${dizin}:${process.env.PATH}`, sayac };
}

async function cagriSayisi(sayac: string): Promise<number> {
  try {
    return (await readFile(sayac, 'utf8')).split('\n').filter((satir) => satir !== '').length;
  } catch {
    return 0;
  }
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(geciciler.splice(0).map(async (dizin) => {
    await (await import('node:fs/promises')).rm(dizin, { recursive: true, force: true });
  }));
});

describe('JSON ayıklama', () => {
  it.each([
    ['çitli', '```json\n{"tamam":true}\n```'],
    ['açıklamalı', 'İşte yanıt: {"tamam":true} teşekkürler'],
    ['dizi ve dizge', 'not [{"metin":"} kaçış \\" tamam"}] son'],
  ])('%s yanıttaki ilk JSON bloğunu ayıklar', (_ad, metin) => {
    expect(ilkJsonBlogu(metin)).toBe(_ad === 'dizi ve dizge' ? '[{"metin":"} kaçış \\" tamam"}]' : '{"tamam":true}');
  });
});

describe('eksik kapanış onarımı', () => {
  it('kesilmiş nesneyi açık parantezleri kapatarak tamamlar', () => {
    const kesik = '{"a":[{"b":"x"},{"b":"y"}';
    expect(JSON.parse(eksikKapanislariTamamla(kesik) ?? 'null')).toEqual({ a: [{ b: 'x' }, { b: 'y' }] });
  });
  it('sondaki virgülü atar ve dizge içinde kesilmişse onarmaz', () => {
    expect(JSON.parse(eksikKapanislariTamamla('{"a":1,') ?? 'null')).toEqual({ a: 1 });
    expect(eksikKapanislariTamamla('{"a":"kes')).toBeNull();
    expect(eksikKapanislariTamamla('metin yok')).toBeNull();
  });
  it('dengeli metne dokunmaz', () => {
    expect(eksikKapanislariTamamla('önsöz {"a":1} sonsöz')).toBe('{"a":1}');
  });
});

describe('CLI adaptörleri', () => {
  it('Claude çağrı tavanını kalan toplam bütçeyle sınırlar', () => {
    const butce = new BeyinButcesi({ adaptor: 'claude', maxBudgetUsd: 0.4, maxTotalCostUsd: 0.5 }, {});
    const ilk = butce.claudeCagrisiBaslat();
    expect(ilk.azamiMaliyetUsd).toBe(0.4);
    butce.cagriTamamla(ilk, 0.3);
    const ikinci = butce.claudeCagrisiBaslat();
    expect(ikinci.azamiMaliyetUsd).toBeCloseTo(0.2);
    butce.cagriIptal(ikinci);
  });

  it('varsayılan Claude çağrı tavanı büyük planlar için 1 USD olur', () => {
    expect(VARSAYILAN_CLAUDE_BUTCESI_USD).toBe(1);
  });

  it('claude bayraklarını geçirir, stdin istemini kullanır ve iç JSON sonucu ayıklar', async () => {
    await chmod(join(cliDizini, 'claude'), 0o755);
    const kayit = join(await geciciDizin(), 'claude-kayit.json');
    const logDizini = await geciciDizin();
    const beyin = beyinOlustur({ adaptor: 'claude', model: 'sonnet', maxBudgetUsd: 0.3 }, ortam({
      KOBAY_MAX_BUDGET_USD: '0.4',
      KOBAY_SAHTE_KAYIT: kayit,
      KOBAY_SAHTE_CIKTI: await ciktiDosyasi(JSON.stringify({
        result: 'önce ```json\n{"tamam":true}\n``` sonra',
        total_cost_usd: 0.012,
        num_turns: 2,
        is_error: false,
      })),
    }));

    await expect(beyin.sor({ gorev: 'plan', sistem: 'Sistem', kullanici: 'Kullanıcı', sema, logDizini })).resolves.toMatchObject({
      json: { tamam: true }, adaptor: 'claude', maliyetUsd: 0.012, turSayisi: 2, hataMi: false,
    });
    const kaydedilen = JSON.parse(await readFile(kayit, 'utf8')) as { argumanlar: string[]; girdi: string };
    expect(kaydedilen.argumanlar).toEqual(expect.arrayContaining([
      '-p', '--output-format', 'json', '--safe-mode', '--tools', '', '--setting-sources', 'local',
      '--strict-mcp-config', '--no-session-persistence', '--max-budget-usd', '0.4', '--model', 'sonnet',
    ]));
    expect(kaydedilen.girdi).toContain('Sistem\n\nKullanıcı');
    await expect(readFile(join(logDizini, 'beyin-plan-1.log'), 'utf8')).resolves
      .toContain('"maliyetUsd":0.012,"turSayisi":2,"hataMi":false');
  });

  it('ANTHROPIC_API_KEY varsa kullanıcıyı süreçte yalnız bir kez stderr üzerinden uyarır', async () => {
    await chmod(join(cliDizini, 'claude'), 0o755);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const beyin = beyinOlustur({ adaptor: 'claude' }, ortam({
      ANTHROPIC_API_KEY: 'test-anahtari',
      KOBAY_SAHTE_CIKTI: await ciktiDosyasi('{"result":"{\\"tamam\\":true}","total_cost_usd":0.01}'),
    }));

    await beyin.sor({ gorev: 'bir', sistem: 'S', kullanici: 'K', sema });
    await beyin.sor({ gorev: 'iki', sistem: 'S', kullanici: 'K', sema });

    const uyarilar = stderr.mock.calls.map(([metin]) => String(metin)).filter((metin) => metin.includes('ANTHROPIC_API_KEY'));
    expect(uyarilar).toHaveLength(1);
    expect(uyarilar[0]).toContain('faturalanabilir');
  });

  it('codex bayraklarını geçirir ve -o dosyasındaki JSON yanıtını okur', async () => {
    await chmod(join(cliDizini, 'codex'), 0o755);
    const kayit = join(await geciciDizin(), 'codex-kayit.json');
    const beyin = beyinOlustur({ adaptor: 'codex', model: 'gpt-5', effort: 'high' }, ortam({
      KOBAY_SAHTE_KAYIT: kayit,
      KOBAY_SAHTE_CIKTI: await ciktiDosyasi('açıklama {"tamam":true}'),
    }));

    const yanit = await beyin.sor({ gorev: 'uretim', sistem: 'Sistem', kullanici: 'Kullanıcı', sema });
    expect(yanit).toMatchObject({
      json: { tamam: true }, adaptor: 'codex',
    });
    expect(yanit).not.toHaveProperty('maliyetUsd');
    const kaydedilen = JSON.parse(await readFile(kayit, 'utf8')) as { argumanlar: string[]; girdi: string };
    expect(kaydedilen.argumanlar).toEqual(expect.arrayContaining([
      'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', 'gpt-5',
      '-c', 'model_reasoning_effort=high', '-o', '-',
    ]));
    expect(kaydedilen.argumanlar.at(-1)).toBe('-');
    expect(kaydedilen.argumanlar).not.toContain(expect.stringContaining('Kullanıcı'));
    expect(kaydedilen.girdi).toContain('Sistem\n\nKullanıcı');
  });

  it('süre dolunca süreci sonlandırıp zaman_aşımı hatası verir', async () => {
    await chmod(join(cliDizini, 'claude'), 0o755);
    const beyin = beyinOlustur({ adaptor: 'claude' }, ortam({
      KOBAY_SAHTE_BEKLE_MS: '200',
      KOBAY_SAHTE_CIKTI: await ciktiDosyasi('{"result":"{\\"tamam\\":true}","total_cost_usd":0.01}'),
    }));
    await expect(beyin.sor({ gorev: 'yavas', sistem: 'S', kullanici: 'K', sema, zamanAsimiSn: 0.02 }))
      .rejects.toMatchObject({ sebep: 'zaman_asimi' });
  });

  it('CLI PATH içinde yoksa cli_yok hatası verir', async () => {
    const beyin = beyinOlustur({ adaptor: 'claude' }, { PATH: join(await geciciDizin(), 'bos') });
    await expect(beyin.sor({ gorev: 'yok', sistem: 'S', kullanici: 'K', sema }))
      .rejects.toMatchObject({ sebep: 'cli_yok' });
  });

  it('CLI sıfır olmayan kodla çıkarsa stderr özetini maskeleyip cli_hatasi olarak günlüğe yazar', async () => {
    const binDizini = await geciciDizin();
    const claudeYolu = join(binDizini, 'claude');
    await writeFile(claudeYolu, '#!/usr/bin/env node\nprocess.stderr.write("Authorization: Bearer cok-gizli-token\\n");\nprocess.exit(7);\n');
    await chmod(claudeYolu, 0o755);
    const logDizini = await geciciDizin();
    const beyin = beyinOlustur({ adaptor: 'claude' }, {
      PATH: process.env.PATH === undefined ? binDizini : `${binDizini}:${process.env.PATH}`,
    });

    const hata = await beyin.sor({ gorev: 'cli', sistem: 'S', kullanici: 'K', sema, logDizini }).catch((neden: unknown) => neden);
    expect(hata).toMatchObject({ sebep: 'cli_hatasi', message: expect.stringContaining('CLI 7') });
    expect((hata as Error).message).toContain('[maskelendi]');
    expect((hata as Error).message).not.toContain('cok-gizli-token');
    const gunluk = await readFile(join(logDizini, 'beyin-cli-1.log'), 'utf8');
    expect(gunluk).toContain('[maskelendi]');
    expect(gunluk).not.toContain('cok-gizli-token');
  });

  it('Claude is_error bütçe yanıtını yeniden denemeden maliyet_tavani olarak açıklar', async () => {
    await chmod(join(cliDizini, 'claude'), 0o755);
    const kayit = join(await geciciDizin(), 'claude-kayit.json');
    const beyin = beyinOlustur({ adaptor: 'claude' }, ortam({
      KOBAY_SAHTE_KAYIT: kayit,
      KOBAY_SAHTE_CIKTI: await ciktiDosyasi(JSON.stringify({
        result: 'Maximum budget reached', total_cost_usd: 0.25, is_error: true,
      })),
    }));

    await expect(beyin.sor({ gorev: 'butce', sistem: 'S', kullanici: 'K', sema })).rejects.toMatchObject({
      sebep: 'maliyet_tavani',
      message: expect.stringContaining('KOBAY_MAX_BUDGET_USD'),
    });
    const kaydedilen = JSON.parse(await readFile(kayit, 'utf8')) as { girdi: string };
    expect(kaydedilen.girdi).not.toContain('Önceki yanıt şemaya uymadı');
  });
});

describe('şema, günlük ve diğer adaptörler', () => {
  it('şema hatasında bir kez tekrar dener; ikinci hatada ham yanıtla sema hatası verir', async () => {
    const logDizini = await geciciDizin();
    const icIceSema = v.object({ oneriler: v.array(v.object({ steps: v.array(v.object({ description: v.string() })) })) });
    const tamamlamalar = [
      new Response(JSON.stringify({ choices: [{ message: { content: '{"oneriler":[{"steps":[{}]}]}' } }], usage: { cost: 0.005 } }), { status: 200 }),
      new Response(JSON.stringify({ choices: [{ message: { content: '{"oneriler":[{"steps":[{}]}]}' } }], usage: { cost: 0.005 } }), { status: 200 }),
    ];
    const fetchSahte = vi.fn().mockImplementation(async (url: string) => (
      url.includes('/api/v1/model/') ? fiyatYaniti() : tamamlamalar.shift()
    ));
    vi.stubGlobal('fetch', fetchSahte);
    const beyin = beyinOlustur({ adaptor: 'openrouter', model: 'test/model' }, { OPENROUTER_API_KEY: 'test-anahtar' });
    await expect(beyin.sor({ gorev: 'tekrar', sistem: 'S', kullanici: 'K', sema: icIceSema, logDizini }))
      .rejects.toMatchObject({ sebep: 'sema', ham: '{"oneriler":[{"steps":[{}]}]}' } satisfies Partial<BeyinHatasi>);
    expect(fetchSahte).toHaveBeenCalledTimes(3);
    const tamamlamaCagrilari = fetchSahte.mock.calls.filter(([url]) => String(url).includes('/chat/completions'));
    expect(JSON.parse(String(tamamlamaCagrilari[1]?.[1]?.body)).messages[0].content)
      .toContain('oneriler[0].steps[0].description');
    await expect(readFile(join(logDizini, 'beyin-tekrar-1.log'), 'utf8')).resolves.toContain('---\n{"oneriler":[{"steps":[{}]}]}');
    await expect(readFile(join(logDizini, 'beyin-tekrar-2.log'), 'utf8')).resolves.toContain('---\n{"oneriler":[{"steps":[{}]}]}');
  });

  it('sahte adaptör dosyadaki yanıtı döner, yoksa bos_yanit verir ve günlük yazar', async () => {
    const yanitDizini = await geciciDizin();
    const logDizini = await geciciDizin();
    await writeFile(join(yanitDizini, 'plan.json'), '{"tamam":true}');
    const beyin = beyinOlustur({ adaptor: 'sahte' }, { KOBAY_SAHTE_YANIT_DIZINI: yanitDizini });
    await expect(beyin.sor({ gorev: 'plan', sistem: 'S', kullanici: 'K', sema, logDizini })).resolves.toMatchObject({ json: { tamam: true } });
    await expect(readFile(join(logDizini, 'beyin-plan-1.log'), 'utf8')).resolves.toContain('---\n{"tamam":true}');
    await expect(beyin.sor({ gorev: 'yok', sistem: 'S', kullanici: 'K', sema }))
      .rejects.toMatchObject({ sebep: 'bos_yanit' });
  });

  it('OpenRouter doğru istek gövdesi ve yetkilendirme başlığını gönderir; anahtar yoksa açık hata verir', async () => {
    const fetchSahte = vi.fn().mockImplementation(async (url: string) => (
      url.includes('/api/v1/model/')
        ? fiyatYaniti()
        : new Response(JSON.stringify({
          choices: [{ message: { content: '{"tamam":true}' } }],
          usage: { cost: 0.005 },
        }), { status: 200 })
    ));
    vi.stubGlobal('fetch', fetchSahte);
    const beyin = beyinOlustur({ adaptor: 'openrouter', model: 'openai/gpt-test' }, { OPENROUTER_API_KEY: 'gizli' });
    await expect(beyin.sor({ gorev: 'ag', sistem: 'S', kullanici: 'K', sema })).resolves.toMatchObject({
      json: { tamam: true }, maliyetUsd: 0.005,
    });
    expect(fetchSahte).toHaveBeenCalledWith('https://openrouter.ai/api/v1/chat/completions', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer gizli' }),
    }));
    const ilkTamamlama = fetchSahte.mock.calls.find(([url]) => String(url).includes('/chat/completions'));
    expect(JSON.parse(String(ilkTamamlama?.[1]?.body))).toMatchObject({
      model: 'openai/gpt-test', response_format: { type: 'json_object' }, max_tokens: 4096,
      usage: { include: true }, provider: { max_price: { prompt: 1, completion: 2 } },
    });
    const varsayilanBeyin = beyinOlustur({ adaptor: 'openrouter' }, { OPENROUTER_API_KEY: 'gizli' });
    await varsayilanBeyin.sor({ gorev: 'varsayilan', sistem: 'S', kullanici: 'K', sema });
    const tamamlamalar = fetchSahte.mock.calls.filter(([url]) => String(url).includes('/chat/completions'));
    expect(JSON.parse(String(tamamlamalar[1]?.[1]?.body))).toMatchObject({
      model: 'google/gemini-3.8-flash', max_tokens: 4096,
    });
    await expect(beyinOlustur({ adaptor: 'openrouter' }, {}).sor({ gorev: 'ag', sistem: 'S', kullanici: 'K', sema }))
      .rejects.toMatchObject({ sebep: 'anahtar_yok' });
  });

  it('aynı süreç ortamını paylaşan beyin örneklerinde çağrı tavanını aşınca ikinci çağrıyı başlatmaz', async () => {
    const yanitDizini = await geciciDizin();
    await writeFile(join(yanitDizini, 'sinir.json'), '{"tamam":true}');
    const paylasilanOrtam = { KOBAY_SAHTE_YANIT_DIZINI: yanitDizini };
    const ilkBeyin = beyinOlustur({ adaptor: 'sahte', maxCalls: 1 }, paylasilanOrtam);
    const ikinciBeyin = beyinOlustur({ adaptor: 'sahte', maxCalls: 1 }, paylasilanOrtam);

    const ilkYanit = await ilkBeyin.sor({ gorev: 'sinir', sistem: 'S', kullanici: 'K', sema });
    expect(ilkYanit).toMatchObject({ json: { tamam: true } });
    expect(ilkYanit).not.toHaveProperty('maliyetUsd');
    await expect(ikinciBeyin.sor({ gorev: 'sinir', sistem: 'S', kullanici: 'K', sema })).rejects.toMatchObject({
      sebep: 'cagri_tavani',
      message: expect.stringContaining('KOBAY_MAX_BRAIN_CALLS'),
    });
  });

  it('aynı süreçte politika değişince sayaç sıfırlanmaz; en katı çağrı tavanı herkese uygulanır', async () => {
    const yanitDizini = await geciciDizin();
    await writeFile(join(yanitDizini, 'ayri.json'), '{"tamam":true}');
    const paylasilanOrtam = { KOBAY_SAHTE_YANIT_DIZINI: yanitDizini };
    const genis = beyinOlustur({ adaptor: 'sahte', maxCalls: 10 }, paylasilanOrtam);
    await genis.sor({ gorev: 'ayri', sistem: 'S', kullanici: 'K', sema });
    await genis.sor({ gorev: 'ayri', sistem: 'S', kullanici: 'K', sema });
    const dar = beyinOlustur({ adaptor: 'sahte', maxCalls: 3 }, paylasilanOrtam);
    await expect(dar.sor({ gorev: 'ayri', sistem: 'S', kullanici: 'K', sema })).resolves.toMatchObject({
      json: { tamam: true },
    });
    // Dar politika önceki beyne de uygulanır; sonra gelen gevşek politika tavanı yükseltmez.
    await expect(genis.sor({ gorev: 'ayri', sistem: 'S', kullanici: 'K', sema })).rejects.toMatchObject({
      sebep: 'cagri_tavani',
    });
    const gevsek = beyinOlustur({ adaptor: 'sahte', maxCalls: 1000 }, paylasilanOrtam);
    await expect(gevsek.sor({ gorev: 'ayri', sistem: 'S', kullanici: 'K', sema })).rejects.toMatchObject({
      sebep: 'cagri_tavani',
      message: expect.stringContaining('kullanıcıdan onay isteyin'),
    });
  });

  it('OpenRouter en kötü maliyet toplam tavanı aşıyorsa ücretli çağrıyı başlatmaz', async () => {
    const fetchSahte = vi.fn().mockImplementation(async (url: string) => (
      url.includes('/api/v1/model/') ? fiyatYaniti('0.000001', '0.0002') : new Response('{}')
    ));
    vi.stubGlobal('fetch', fetchSahte);
    const beyin = beyinOlustur({ adaptor: 'openrouter', maxTotalCostUsd: 0.5 }, { OPENROUTER_API_KEY: 'test' });

    await expect(beyin.sor({ gorev: 'pahali', sistem: 'S', kullanici: 'K', sema })).rejects.toMatchObject({
      sebep: 'maliyet_tavani',
      message: expect.stringContaining('KOBAY_MAX_TOTAL_COST_USD'),
    });
    expect(fetchSahte).toHaveBeenCalledTimes(1);
    expect(String(fetchSahte.mock.calls[0]?.[0])).toContain('/api/v1/model/');
  });

  it('şema tekrar denemesi de gerçek çağrı tavanına dahildir', async () => {
    const fetchSahte = vi.fn().mockImplementation(async (url: string) => (
      url.includes('/api/v1/model/')
        ? fiyatYaniti()
        : new Response(JSON.stringify({
          choices: [{ message: { content: '{"yanlis":true}' } }], usage: { cost: 0.005 },
        }), { status: 200 })
    ));
    vi.stubGlobal('fetch', fetchSahte);
    const beyin = beyinOlustur({ adaptor: 'openrouter', maxCalls: 1 }, { OPENROUTER_API_KEY: 'test' });

    await expect(beyin.sor({ gorev: 'tekrar-siniri', sistem: 'S', kullanici: 'K', sema })).rejects.toMatchObject({
      sebep: 'cagri_tavani',
    });
    expect(fetchSahte).toHaveBeenCalledTimes(2);
  });

  it('OpenRouter fiyat bilgisi eksikse ücretli çağrı yapmadan kapalı davranır', async () => {
    const fetchSahte = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { pricing: {} } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSahte);
    const beyin = beyinOlustur({ adaptor: 'openrouter' }, { OPENROUTER_API_KEY: 'test' });

    await expect(beyin.sor({ gorev: 'fiyatsiz', sistem: 'S', kullanici: 'K', sema })).rejects.toMatchObject({
      sebep: 'maliyet_bilinmiyor', message: expect.stringContaining('çağrı başlatılmadı'),
    });
    expect(fetchSahte).toHaveBeenCalledTimes(1);
  });

  it('OpenRouter yanıt maliyeti eksikse rezervasyonu harcanmış sayıp yeni çağrıyı durdurur', async () => {
    const fetchSahte = vi.fn().mockImplementation(async (url: string) => (
      url.includes('/api/v1/model/')
        ? fiyatYaniti()
        : new Response(JSON.stringify({ choices: [{ message: { content: '{"tamam":true}' } }] }), { status: 200 })
    ));
    vi.stubGlobal('fetch', fetchSahte);
    const beyin = beyinOlustur(
      { adaptor: 'openrouter', maxTotalCostUsd: 0.01 },
      { OPENROUTER_API_KEY: 'test' },
    );

    await expect(beyin.sor({ gorev: 'maliyetsiz', sistem: 'S', kullanici: 'K', sema })).rejects.toMatchObject({
      sebep: 'maliyet_bilinmiyor', message: expect.stringContaining('rezervasyon harcanmış sayıldı'),
    });
    await expect(beyin.sor({ gorev: 'ikinci', sistem: 'S', kullanici: 'K', sema })).rejects.toMatchObject({
      sebep: 'maliyet_tavani',
    });
    expect(fetchSahte.mock.calls.filter(([url]) => String(url).includes('/chat/completions'))).toHaveLength(1);
  });

  it('eşzamanlı OpenRouter çağrılarında rezervasyon atomiktir; istek gönderildikten sonraki ağ hatasında iade yok', async () => {
    let ilkReddet: ((hata: Error) => void) | undefined;
    const ilkTamamlama = new Promise<Response>((_coz, red) => { ilkReddet = red; });
    let tamamlamaSayisi = 0;
    const fetchSahte = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/model/')) return fiyatYaniti('0.000001', '0.00008');
      tamamlamaSayisi += 1;
      if (tamamlamaSayisi === 1) return ilkTamamlama;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"tamam":true}' } }], usage: { cost: 0.1 },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSahte);
    const beyin = beyinOlustur(
      { adaptor: 'openrouter', maxTotalCostUsd: 0.5 },
      { OPENROUTER_API_KEY: 'test' },
    );

    const ilk = beyin.sor({ gorev: 'ilk', sistem: 'S', kullanici: 'K', sema });
    await vi.waitFor(() => { expect(tamamlamaSayisi).toBe(1); });
    await expect(beyin.sor({ gorev: 'es-zamanli', sistem: 'S', kullanici: 'K', sema })).rejects.toMatchObject({
      sebep: 'maliyet_tavani',
    });
    expect(tamamlamaSayisi).toBe(1);

    ilkReddet?.(new Error('ağ kesildi'));
    await expect(ilk).rejects.toMatchObject({ sebep: 'ag' });
    // Sağlayıcı faturalamış olabilir: ~0.33 USD rezervasyon harcanmış sayılır, kalan 0.17 yeni çağrıya yetmez.
    await expect(beyin.sor({ gorev: 'iade-yok', sistem: 'S', kullanici: 'K', sema })).rejects.toMatchObject({
      sebep: 'maliyet_tavani',
    });
    expect(tamamlamaSayisi).toBe(1);
  });

  it('maliyet rezervasyonunu eşzamanlı kontrolde sayar ve başarısız çağrıda iade eder', () => {
    const butce = new BeyinButcesi({ adaptor: 'openrouter', maxTotalCostUsd: 0.5 }, {});
    const ilk = butce.cagriBaslat(0.3);
    expect(() => butce.cagriBaslat(0.3)).toThrow(/kalan 0\.2000 USD/);
    butce.cagriIptal(ilk);
    const ikinci = butce.cagriBaslat(0.3);
    expect(ikinci.azamiMaliyetUsd).toBe(0.3);
    butce.cagriTamamla(ikinci, 0.1);
  });
});

describe('denetim 3 regresyonları (para korumaları)', () => {
  it('#1 OpenRouter gerçek model yanıtında request alanı yoksa 0 sayar ve çağrıyı yapar', async () => {
    const fetchSahte = vi.fn().mockImplementation(async (url: string) => (
      url.includes('/api/v1/model/')
        ? new Response(JSON.stringify(GERCEK_OPENROUTER_MODEL_YANITI), { status: 200 })
        : new Response(JSON.stringify({
          choices: [{ message: { content: '{"tamam":true}' } }], usage: { cost: 0.0004 },
        }), { status: 200 })
    ));
    vi.stubGlobal('fetch', fetchSahte);
    const beyin = beyinOlustur({ adaptor: 'openrouter' }, { OPENROUTER_API_KEY: 'test' });

    await expect(beyin.sor({ gorev: 'gercek-fiyat', sistem: 'S', kullanici: 'K', sema })).resolves.toMatchObject({
      json: { tamam: true }, maliyetUsd: 0.0004,
    });
    expect(String(fetchSahte.mock.calls[0]?.[0])).toBe('https://openrouter.ai/api/v1/model/google/gemini-3.8-flash');
    const govde = JSON.parse(String(fetchSahte.mock.calls[1]?.[1]?.body)) as { provider: { max_price: unknown } };
    expect(govde.provider.max_price).toEqual({ prompt: 0.75, completion: 3.75 });
  });

  it.each([
    ['request bozuk', { prompt: '0.000001', completion: '0.000002', request: 'bedava' }],
    ['request negatif', { prompt: '0.000001', completion: '0.000002', request: '-1' }],
    ['completion yok', { prompt: '0.000001' }],
    ['prompt yok', { completion: '0.000002' }],
  ])('#1 OpenRouter fiyatında %s ise ücretli çağrı yapmadan kapalı davranır', async (_ad, pricing) => {
    const fetchSahte = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { pricing } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSahte);
    const beyin = beyinOlustur({ adaptor: 'openrouter', model: 'test/model' }, { OPENROUTER_API_KEY: 'test' });

    await expect(beyin.sor({ gorev: 'fiyat', sistem: 'S', kullanici: 'K', sema })).rejects.toMatchObject({
      sebep: 'maliyet_bilinmiyor',
    });
    expect(fetchSahte).toHaveBeenCalledTimes(1);
  });

  it('#5 Claude sıfır dışı çıkışta stdout JSON maliyetiyle uzlaşır, iade etmez (butce.mts)', async () => {
    const cli = await sahteCliDizini('claude');
    const beyin = beyinOlustur({ adaptor: 'claude', maxBudgetUsd: 1, maxTotalCostUsd: 1.8 }, {
      PATH: cli.path,
      T_KOD: '1',
      T_CIKTI: JSON.stringify({
        type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0.9, result: '',
      }),
    });

    for (let i = 0; i < 2; i += 1) {
      await expect(beyin.sor({ gorev: 'cikis1', sistem: 'S', kullanici: 'K', sema })).rejects.toMatchObject({
        sebep: 'cli_hatasi',
      });
    }
    await expect(beyin.sor({ gorev: 'cikis1', sistem: 'S', kullanici: 'K', sema })).rejects.toMatchObject({
      sebep: 'maliyet_tavani',
    });
    expect(await cagriSayisi(cli.sayac)).toBe(2);
  });

  it('#5 Claude zaman aşımında maliyet okunamazsa rezervasyonun tamamı harcanmış sayılır', async () => {
    const cli = await sahteCliDizini('claude');
    const beyin = beyinOlustur({ adaptor: 'claude', maxBudgetUsd: 1, maxTotalCostUsd: 1 }, {
      PATH: cli.path,
      T_BEKLE_MS: '2000',
      T_CIKTI: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result: '{"tamam":true}' }),
    });

    // `zaman_asimi` hatası zaten CLI'nin açılıp SIGTERM ile kesildiğini kanıtlar.
    await expect(beyin.sor({ gorev: 'yavas', sistem: 'S', kullanici: 'K', sema, zamanAsimiSn: 0.3 }))
      .rejects.toMatchObject({ sebep: 'zaman_asimi' });
    const zamanAsimindanSonra = await cagriSayisi(cli.sayac);

    // Maliyet okunamadığı için rezervasyonun tamamı harcanmış sayılır: toplam
    // bütçe bittiğinden ikinci çağrı CLI'yi hiç çalıştırmadan reddedilmeli.
    // Mutlak sayı yerine artışa bakılır; kesilen sürecin kaydı yetişip
    // yetişmediği makinenin süreç açma hızına bağlıdır, davranışa değil.
    await expect(beyin.sor({ gorev: 'yavas', sistem: 'S', kullanici: 'K', sema, zamanAsimiSn: 0.3 }))
      .rejects.toMatchObject({ sebep: 'maliyet_tavani' });
    expect(await cagriSayisi(cli.sayac)).toBe(zamanAsimindanSonra);
  });

  it('#5 süreç hiç başlamazsa (CLI yok) rezervasyon iade edilir', async () => {
    const beyin = beyinOlustur(
      { adaptor: 'claude', maxBudgetUsd: 1, maxTotalCostUsd: 1 },
      { PATH: join(await geciciDizin(), 'bos') },
    );
    await expect(beyin.sor({ gorev: 'yok', sistem: 'S', kullanici: 'K', sema })).rejects.toMatchObject({ sebep: 'cli_yok' });
    await expect(beyin.sor({ gorev: 'yok', sistem: 'S', kullanici: 'K', sema })).rejects.toMatchObject({ sebep: 'cli_yok' });
  });

  it.each([['0'], ['1']])('#5 Claude bütçe aşımını subtype ile tanır (çıkış kodu %s), metne bakmaz, yeniden denemez', async (kod) => {
    const cli = await sahteCliDizini('claude');
    const beyin = beyinOlustur({ adaptor: 'claude', maxBudgetUsd: 0.5, maxTotalCostUsd: 5 }, {
      PATH: cli.path,
      T_KOD: kod,
      T_CIKTI: JSON.stringify({
        type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.52, num_turns: 1,
      }),
    });

    const hata = await beyin.sor({ gorev: 'butce', sistem: 'S', kullanici: 'K', sema }).catch((neden: unknown) => neden);
    expect(hata).toMatchObject({ sebep: 'maliyet_tavani' });
    expect((hata as Error).message).toContain('kullanıcıdan onay isteyin');
    expect((hata as Error).message).not.toMatch(/değerini artırın/);
    expect(await cagriSayisi(cli.sayac)).toBe(1);
  });

  it('#5 Claude başarı çıktısı JSON değilse rezervasyon harcanmış sayılır', async () => {
    const cli = await sahteCliDizini('claude');
    const beyin = beyinOlustur({ adaptor: 'claude', maxBudgetUsd: 1, maxTotalCostUsd: 1 }, {
      PATH: cli.path, T_CIKTI: 'JSON değil',
    });
    await expect(beyin.sor({ gorev: 'bozuk', sistem: 'S', kullanici: 'K', sema })).rejects.toMatchObject({ sebep: 'cli_hatasi' });
    await expect(beyin.sor({ gorev: 'bozuk', sistem: 'S', kullanici: 'K', sema })).rejects.toMatchObject({ sebep: 'maliyet_tavani' });
    expect(await cagriSayisi(cli.sayac)).toBe(1);
  });

  it('#6 codex kullanıcı ayarlarını ve oturum kaydını kapatan bayrakları prompt\'tan önce geçirir', async () => {
    const cli = await sahteCliDizini('codex');
    const beyin = beyinOlustur({ adaptor: 'codex', model: 'gpt-5', effort: 'low' }, {
      PATH: cli.path, T_CIKTI: '{"tamam":true}',
    });
    await beyin.sor({ gorev: 'codex', sistem: 'S', kullanici: 'K', sema });
    const argumanlar = JSON.parse((await readFile(cli.sayac, 'utf8')).split('\n')[0] ?? '[]') as string[];
    expect(argumanlar[0]).toBe('exec');
    expect(argumanlar).toContain('--ignore-user-config');
    expect(argumanlar).toContain('--ephemeral');
    expect(argumanlar.indexOf('--ignore-user-config')).toBeLessThan(argumanlar.indexOf('-'));
    expect(argumanlar).toEqual(expect.arrayContaining(['-m', 'gpt-5', '-c', 'model_reasoning_effort=low']));
  });

  it('#8 tavan her çağrıda biraz artırılsa da sayaç sıfırlanmaz (taze.mts)', async () => {
    const cli = await sahteCliDizini('claude');
    const env = {
      PATH: cli.path,
      T_CIKTI: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.9, result: '{"tamam":true}' }),
    };
    let basarili = 0;
    const hatalar: string[] = [];
    for (const tavan of [1, 1.01, 1.02]) {
      const beyin = beyinOlustur({ adaptor: 'claude', maxTotalCostUsd: tavan }, env);
      for (let i = 0; i < 3; i += 1) {
        try {
          await beyin.sor({ gorev: 'taze', sistem: 'S', kullanici: 'K', sema });
          basarili += 1;
        } catch (hata) {
          hatalar.push((hata as Error).message);
          break;
        }
      }
    }
    // İlk çağrı 0.9 harcar; ikinci çağrı kalan ~0.1 ile (--max-budget-usd 0.1) başlar, sahte CLI bunu aşınca
    // maliyet_tavani; sonraki gevşek politikalar sayaç sıfırlamaz, yeni çağrı başlamaz.
    expect(basarili).toBe(1);
    expect(await cagriSayisi(cli.sayac)).toBe(2);
    expect(hatalar.at(-1)).toContain('kullanıcıdan onay isteyin');
    expect(hatalar.join('\n')).not.toMatch(/değerini artırın/);
  });

  it('#8 gevşek politika sonradan gelse de en katı toplam tavan korunur', () => {
    const butce = new BeyinButcesi({ adaptor: 'openrouter', maxTotalCostUsd: 0.5 }, {});
    butce.cagriTamamla(butce.cagriBaslat(0.3), 0.3);
    butce.politikaEkle({ adaptor: 'openrouter', maxTotalCostUsd: 100 }, {});
    expect(() => butce.cagriBaslat(0.3)).toThrow(/kalan 0\.2000 USD/);
    butce.politikaEkle({ adaptor: 'openrouter', maxTotalCostUsd: 0.4 }, {});
    expect(() => butce.cagriBaslat(0.15)).toThrow(/Tavan 0\.4000 USD/);
  });
});
