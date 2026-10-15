import { readFile } from 'node:fs/promises';
import { beyinOlustur } from '../../beyin/index.js';
import { oneriyiTesteCevir, planUret } from '../../plan/index.js';
import { UsageError, basarili, komutCalistir, type KomutSonucu } from '../komut.js';
import { dizinBul, haritaSagla, kayitliProjeDosyasi } from './ortak.js';

export async function planGenerate(a: { cwd: string; hint?: string }): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const dizin = await dizinBul(a.cwd);
    const config = await dizin.configOku();
    // Belge yolu keşiften önce denetlenir: reddedilecek bir belge için tarayıcı açılmaz.
    const belgeYolu = config.docsPath === undefined
      ? undefined
      : await kayitliProjeDosyasi(dizin, config.docsPath, 'docsPath');
    const harita = await haritaSagla(dizin);
    const belge = belgeYolu === undefined ? undefined : await readFile(belgeYolu, 'utf8');
    const beyin = beyinOlustur(config.brain, process.env);
    const sonuc = await planUret(
      beyin,
      harita,
      belge,
      a.hint,
      dizin.yol('logs'),
    );
    await dizin.onerileriYaz(sonuc.proposals);
    const tablo = sonuc.proposals.map((oneri) => ({
      id: oneri.proposalId,
      priority: oneri.priority,
      title: oneri.title,
      stepCount: oneri.steps.length,
    }));
    const uretilen = `${sonuc.proposals.length} proposal${sonuc.proposals.length === 1 ? '' : 's'} generated`;
    const uyari = sonuc.dropped.length === 0
      ? uretilen
      : `${uretilen}; ${sonuc.dropped.length} dropped: ${sonuc.dropped.map((o) => `${o.title} (${o.reason})`).join(', ')}`
        + (sonuc.nextStep === undefined ? '' : `. ${sonuc.nextStep}`);
    // İnsan modunda özet satırı + öneri başına tek sekmeli satır + düşenler; json zarfı aynen kalır.
    // Beyin metni serbesttir; satır/sekme kaydı bozmasın diye tek boşluğa inilir (json alanına dokunulmaz).
    const tekSatir = (metin: string): string => metin.replace(/[\r\n\t]+/g, ' ');
    const satirlar = [
      uretilen,
      ...tablo.map((o) => `${o.id}\t${o.priority}\t${tekSatir(o.title)}\t${o.stepCount} step${o.stepCount === 1 ? '' : 's'}`),
      ...sonuc.dropped.map((o) => `dropped\t${tekSatir(o.title)}\t${tekSatir(o.reason)}`),
      // Giriş-gerekli düşmede sonraki adım tek satır, bir kez.
      ...(sonuc.nextStep === undefined ? [] : [`next step\t${sonuc.nextStep}`]),
    ];
    return {
      ...basarili({
        proposals: tablo,
        dropped: sonuc.dropped,
        ...(sonuc.nextStep === undefined ? {} : { nextStep: sonuc.nextStep }),
      }, uyari),
      metin: satirlar.join('\n'),
    };
  });
}

export async function planAccept(a: { cwd: string; all?: boolean; ids?: string[] }): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    if (a.all === true && a.ids !== undefined) throw new UsageError('--all and --ids cannot be used together');
    if (a.all !== true && (a.ids === undefined || a.ids.length === 0)) {
      throw new UsageError('--all or --ids is required');
    }
    const dizin = await dizinBul(a.cwd);
    const oneriler = await dizin.onerileriOku();
    const secilenKimlikler = new Set(a.all === true ? oneriler.map((oneri) => oneri.proposalId) : a.ids);
    const bulunan = new Set(oneriler.filter((oneri) => secilenKimlikler.has(oneri.proposalId)).map((oneri) => oneri.proposalId));
    const eksikler = [...secilenKimlikler].filter((id) => !bulunan.has(id));
    if (eksikler.length > 0) throw new UsageError(`Proposal not found: ${eksikler.join(', ')}`);
    const kabul = oneriler.filter((oneri) => secilenKimlikler.has(oneri.proposalId));
    const kalan = oneriler.filter((oneri) => !secilenKimlikler.has(oneri.proposalId));
    const testler = kabul.map(oneriyiTesteCevir);
    await Promise.all(testler.map(async (test) => dizin.testYaz(test)));
    await dizin.onerileriYaz(kalan);
    return basarili(testler, `${testler.length} proposal${testler.length === 1 ? '' : 's'} accepted`);
  });
}
