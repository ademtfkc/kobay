import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';

export interface KomutCozSecenekleri {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface CozulmusKomut {
  komut: string;
  argumanlar: string[];
  spawnSecenekleri: { windowsVerbatimArguments?: true };
}

function yolAyiraci(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

function uzantilar(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') return [''];
  return (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((uzanti) => uzanti !== '');
}

/** PATH ve (Windows'ta) PATHEXT üzerinden çalıştırılabilirin tam yolunu bulur. */
export async function komutCoz(
  ad: string,
  { platform = process.platform, env = process.env, cwd = process.cwd() }: KomutCozSecenekleri = {},
): Promise<string | null> {
  const hamYol = env.PATH ?? env.Path;
  if (hamYol === undefined) return null;
  const dizinler = hamYol.split(yolAyiraci(platform)).map((dizin) => (dizin === '' ? cwd : dizin));
  for (const dizin of dizinler) {
    for (const uzanti of uzantilar(platform, env)) {
      const aday = join(dizin, `${ad}${uzanti}`);
      try {
        await access(aday, constants.X_OK);
        return aday;
      } catch {
        // Bu PATH bileşeninde yok.
      }
    }
  }
  return null;
}

const CMD_META_KARAKTERLERI = /([()\][%!^"`<>&|;, *?])/g;

function cmdMetaKarakterleriniKac(metin: string): string {
  return metin.replace(CMD_META_KARAKTERLERI, '^$1');
}

function windowsArgumaniniAlintila(arguman: string): string {
  // CommandLineToArgvW ters kuralı: tırnaktan önceki ve sondaki ters bölüler iki katlanır.
  const kacisli = arguman
    .replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
    .replace(/(?=(\\+?)?)\1$/g, '$1$1');
  return cmdMetaKarakterleriniKac(`"${kacisli}"`);
}

function ortamDegeri(ortam: NodeJS.ProcessEnv, ad: string): string | undefined {
  const aranan = ad.toLowerCase();
  return Object.entries(ortam).find(([anahtar]) => anahtar.toLowerCase() === aranan)?.[1];
}

/** `.cmd`/`.bat`, Node tarafından kabuksuz başlatılamaz; yalnız bu durumda cmd.exe kullanılır. */
export function komutCagrisiHazirla(
  komut: string,
  argumanlar: string[],
  platform: NodeJS.Platform = process.platform,
  ortam: NodeJS.ProcessEnv = process.env,
): CozulmusKomut {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(komut)) {
    return { komut, argumanlar, spawnSecenekleri: {} };
  }
  const satir = [cmdMetaKarakterleriniKac(komut), ...argumanlar.map(windowsArgumaniniAlintila)].join(' ');
  return {
    komut: ortamDegeri(ortam, 'ComSpec') ?? 'cmd.exe',
    argumanlar: ['/d', '/s', '/c', `"${satir}"`],
    spawnSecenekleri: { windowsVerbatimArguments: true },
  };
}

export interface SurecSonlandirSecenekleri {
  platform?: NodeJS.Platform;
  spawnIslevi?: typeof spawn;
  /**
   * POSIX'te doğrudan çocuğun yanında tüm torunlarını da kapatır (SIGTERM, süre dolunca SIGKILL).
   * Playwright Chromium'u kendi süreç grubunda başlatır; bu yüzden tek grup sinyali yetmez, ağaç okunur.
   */
  agac?: boolean;
  /** SIGTERM sonrası SIGKILL'e geçmeden önce beklenecek süre. */
  zorlaBeklemeMs?: number;
  /** Test için: `pid ppid pgid [başlangıç]` satırları döndüren `ps` çıktısı; okunamazsa boş metin. */
  psOkuyucu?: () => Promise<string>;
  /** `ps` bu sürede yanıt vermezse ağaç okunamamış sayılır (tek çocuk SIGTERM yoluna düşülür). */
  psZamanAsimiMs?: number;
  killIslevi?: (pid: number, sinyal: NodeJS.Signals | 0) => void;
}

export interface SurecAgaci { pidler: number[]; gruplar: number[] }

interface PsSatiri { ppid: number; pgid: number; baslangic: string }

const PS_SUTUNLARI = ['-A', '-o', 'pid=,ppid=,pgid=,lstart='];
const PS_ZAMAN_ASIMI_MS = 2_000;

/** `pid ppid pgid [başlangıç zamanı]` satırlarını ayrıştırır; başlangıç (lstart) opak metin olarak saklanır. */
function psSatirlariniCoz(psCiktisi: string): Map<number, PsSatiri> {
  const satirlar = new Map<number, PsSatiri>();
  for (const satir of psCiktisi.split('\n')) {
    const parcalar = satir.trim().split(/\s+/);
    const [pid, ppid, pgid] = parcalar.slice(0, 3).map(Number);
    if (pid === undefined || ppid === undefined || pgid === undefined) continue;
    if (![pid, ppid, pgid].every(Number.isInteger)) continue;
    satirlar.set(pid, { ppid, pgid, baslangic: parcalar.slice(3).join(' ') });
  }
  return satirlar;
}

/** `ps -A -o pid=,ppid=,pgid=,lstart=` çıktısından kök sürecin torunlarını (ve süreç gruplarını) çıkarır. */
export function surecAgaciniCoz(psCiktisi: string, kokPid: number): SurecAgaci {
  const cocuklar = new Map<number, Array<{ pid: number; pgid: number }>>();
  for (const [pid, { ppid, pgid }] of psSatirlariniCoz(psCiktisi)) {
    const liste = cocuklar.get(ppid) ?? [];
    liste.push({ pid, pgid });
    cocuklar.set(ppid, liste);
  }
  const pidler = new Set<number>();
  const gruplar = new Map<number, number>();
  const kuyruk = [kokPid];
  while (kuyruk.length > 0) {
    const ust = kuyruk.shift()!;
    for (const { pid, pgid } of cocuklar.get(ust) ?? []) {
      if (pidler.has(pid)) continue;
      pidler.add(pid);
      gruplar.set(pid, pgid);
      kuyruk.push(pid);
    }
  }
  // Yalnız lideri torunlardan biri olan gruplara sinyal gider: çocuğun grubu kobay'ın (ve kabuğun) grubudur.
  const kendiGruplari = new Set([...gruplar].filter(([pid, pgid]) => pgid === pid).map(([, pgid]) => pgid));
  return { pidler: [...pidler], gruplar: [...kendiGruplari] };
}

/**
 * İlk anlık görüntüdeki torunlardan, yeni görüntüde hâlâ aynı süreç olup soydan gelenleri seçer.
 * Kimlik: aynı pid + aynı pgid + aynı başlangıç zamanı. Soy: üst süreç kök ya da kalan bir torun;
 * üst süreç çıktıysa (öksüz kalıp başka üste bağlanan torun) kimlik eşleşmesi yeter.
 * Arada ölüp pid'i başka bir sürece geçen torunlar böylece sinyal almaz.
 */
export function soydanKalanlariSec(ilkPs: string, yeniPs: string, kokPid: number): SurecAgaci {
  const ilk = psSatirlariniCoz(ilkPs);
  const yeni = psSatirlariniCoz(yeniPs);
  const ilkAgac = surecAgaciniCoz(ilkPs, kokPid);
  const ayniSurec = (pid: number): boolean => {
    const once = ilk.get(pid);
    const simdi = yeni.get(pid);
    return once !== undefined && simdi !== undefined
      && once.pgid === simdi.pgid && once.baslangic === simdi.baslangic;
  };
  const kalanlar = new Set<number>();
  let degisti = true;
  while (degisti) {
    degisti = false;
    for (const pid of ilkAgac.pidler) {
      if (kalanlar.has(pid) || !ayniSurec(pid)) continue;
      const ustSimdi = yeni.get(pid)!.ppid;
      const ustOnce = ilk.get(pid)!.ppid;
      // ppid yalnız üst süreç çıkınca değişir: ilk üstü artık yoksa, kimliği doğrulanmış öksüz torun hâlâ bizimdir.
      const soyda = ustSimdi === kokPid || kalanlar.has(ustSimdi)
        || (ustSimdi !== ustOnce && !ayniSurec(ustOnce));
      if (soyda) { kalanlar.add(pid); degisti = true; }
    }
  }
  return { pidler: [...kalanlar], gruplar: ilkAgac.gruplar.filter((grup) => kalanlar.has(grup)) };
}

function psOku(): Promise<string> {
  return new Promise((coz) => {
    execFile('ps', PS_SUTUNLARI, { encoding: 'utf8', timeout: PS_ZAMAN_ASIMI_MS, killSignal: 'SIGKILL' },
      (hata, cikti) => { coz(hata ? '' : cikti); });
  });
}

function psOkuSenkron(): string {
  const sonuc = spawnSync('ps', PS_SUTUNLARI, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PS_ZAMAN_ASIMI_MS, killSignal: 'SIGKILL',
  });
  return sonuc.status === 0 ? sonuc.stdout : '';
}

/** Enjekte edilmiş okuyucu bile asılı kalırsa süre dolunca boş metin döner. */
function sureliOku(okuyucu: () => Promise<string>, zamanAsimiMs: number): Promise<string> {
  return new Promise((coz) => {
    const zamanlayici = setTimeout(() => { coz(''); }, zamanAsimiMs);
    okuyucu().then(
      (cikti) => { clearTimeout(zamanlayici); coz(cikti); },
      () => { clearTimeout(zamanlayici); coz(''); },
    );
  });
}

function sinyalGonder(
  agac: SurecAgaci,
  sinyal: NodeJS.Signals,
  killIslevi: (pid: number, sinyal: NodeJS.Signals | 0) => void,
): void {
  // Önce gruplar (Chromium'un yardımcı süreçleri), sonra tek tek pid'ler; ESRCH beklenen durumdur.
  for (const hedef of [...agac.gruplar.map((grup) => -grup), ...agac.pidler]) {
    try { killIslevi(hedef, sinyal); } catch { /* süreç zaten yok */ }
  }
}

function agacCanliMi(agac: SurecAgaci, killIslevi: (pid: number, sinyal: NodeJS.Signals | 0) => void): boolean {
  return agac.pidler.some((pid) => {
    try { killIslevi(pid, 0); return true; } catch { return false; }
  });
}

/**
 * Windows'ta cmd.exe altındaki çocukları da kapatır; taskkill başarısızsa eski SIGTERM yoluna döner.
 * POSIX'te `agac: true` verilirse tüm torunlar da kapatılır (asılı worker'ın Chromium'u öksüz kalmasın).
 */
export async function sureciSonlandir(
  surec: Pick<ChildProcess, 'pid' | 'kill'>,
  {
    platform = process.platform, spawnIslevi = spawn, agac = false, zorlaBeklemeMs = 3_000,
    psOkuyucu = psOku, psZamanAsimiMs = PS_ZAMAN_ASIMI_MS,
    killIslevi = (pid, sinyal) => { process.kill(pid, sinyal); },
  }: SurecSonlandirSecenekleri = {},
): Promise<void> {
  if (platform === 'win32' && surec.pid !== undefined) {
    try {
      const taskkill = spawnIslevi('taskkill', ['/pid', String(surec.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
      const basarili = await new Promise<boolean>((coz) => {
        taskkill.once('error', () => { coz(false); });
        taskkill.once('close', (kod) => { coz(kod === 0); });
      });
      if (basarili) return;
    } catch {
      // taskkill başlatılamazsa mevcut sonlandırma davranışı korunur.
    }
  }
  if (platform === 'win32' || !agac || surec.pid === undefined) {
    surec.kill('SIGTERM');
    return;
  }
  // Ağaç, kök öldürülmeden önce okunur; sonra torunlar köke bağlı olmaktan çıkar.
  const ilkPs = await sureliOku(psOkuyucu, psZamanAsimiMs);
  if (ilkPs.trim() === '') {
    // `ps` okunamadı ya da zaman aşımına düştü (procps yok, BusyBox `lstart` bilmez): torunlar
    // doğrulanamaz, yalnız kök kapatılır. Kök SIGTERM'i yok sayarsa bekleme sonrası SIGKILL alır.
    const kok = surec.pid;
    surec.kill('SIGTERM');
    const kokBitis = Date.now() + zorlaBeklemeMs;
    while (Date.now() < kokBitis && agacCanliMi({ pidler: [kok], gruplar: [] }, killIslevi)) {
      await new Promise<void>((coz) => { setTimeout(coz, 50); });
    }
    try { surec.kill('SIGKILL'); } catch { /* süreç zaten yok */ }
    return;
  }
  const torunlar = surecAgaciniCoz(ilkPs, surec.pid);
  surec.kill('SIGTERM');
  sinyalGonder(torunlar, 'SIGTERM', killIslevi);
  const bitis = Date.now() + zorlaBeklemeMs;
  while (Date.now() < bitis && agacCanliMi(torunlar, killIslevi)) {
    await new Promise<void>((coz) => { setTimeout(coz, 50); });
  }
  // SIGTERM'i yok sayan (Playwright worker'ı yapar) ya da asılı süreçler için. Ağaç yeniden okunur:
  // yalnız hâlâ aynı süreç olup soydan gelenler SIGKILL alır (pid yeniden kullanılmış olabilir).
  // Yeniden okuma başarısızsa doğrulanamayan hiçbir torun SIGKILL almaz.
  const yeniPs = agacCanliMi(torunlar, killIslevi) ? await sureliOku(psOkuyucu, psZamanAsimiMs) : '';
  sinyalGonder(soydanKalanlariSec(ilkPs, yeniPs, surec.pid), 'SIGKILL', killIslevi);
  try { surec.kill('SIGKILL'); } catch { /* süreç zaten yok */ }
}

/**
 * Kobay'ın kendisi SIGINT/SIGTERM alırsa ya da çıkarsa çocuğun ağacını (POSIX) senkron öldürür.
 * Dönen işlev, süreç bitince dinleyicileri kaldırır. Windows'ta bir şey yapmaz.
 */
export function kobayOlurkenAgaciOldur(
  surec: Pick<ChildProcess, 'pid'>,
  platform: NodeJS.Platform = process.platform,
): () => void {
  if (platform === 'win32' || surec.pid === undefined) return () => { /* yapılacak bir şey yok */ };
  const pid = surec.pid;
  const oldur = (): void => {
    const agac = surecAgaciniCoz(psOkuSenkron(), pid);
    sinyalGonder(agac, 'SIGKILL', (hedef, sinyal) => { process.kill(hedef, sinyal); });
    try { process.kill(pid, 'SIGKILL'); } catch { /* süreç zaten yok */ }
  };
  const sinyalDinleyicisi = (sinyal: NodeJS.Signals): void => {
    oldur();
    kaldir();
    // Başka dinleyici yoksa Node'un varsayılan çıkışı bizim yüzümüzden kaybolmuş olur; yeniden gönder.
    if (process.listenerCount(sinyal) === 0) process.kill(process.pid, sinyal);
  };
  const sigint = (): void => { sinyalDinleyicisi('SIGINT'); };
  const sigterm = (): void => { sinyalDinleyicisi('SIGTERM'); };
  const kaldir = (): void => {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
    process.off('exit', oldur);
  };
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  process.on('exit', oldur);
  return kaldir;
}

/** Çözümleme ile çağrı biçimini tek yerde birleştirir. */
export async function komutCagrisiCoz(
  ad: string,
  argumanlar: string[],
  secenekler: KomutCozSecenekleri = {},
): Promise<CozulmusKomut | null> {
  const komut = await komutCoz(ad, secenekler);
  if (komut === null) return null;
  return komutCagrisiHazirla(komut, argumanlar, secenekler.platform ?? process.platform, secenekler.env);
}
