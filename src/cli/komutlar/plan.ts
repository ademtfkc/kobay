import { readFile } from 'node:fs/promises';
import { beyinOlustur } from '../../beyin/index.js';
import { oneriyiTesteCevir, planUret } from '../../plan/index.js';
import { KullanimHatasi, basarili, komutCalistir, type KomutSonucu } from '../komut.js';
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
    const beyin = beyinOlustur(config.beyin, process.env);
    const sonuc = await planUret(
      beyin,
      harita,
      belge,
      a.hint,
      dizin.yol('logs'),
    );
    await dizin.onerileriYaz(sonuc.oneriler);
    const tablo = sonuc.oneriler.map((oneri) => ({
      id: oneri.proposalId,
      oncelik: oneri.priority,
      baslik: oneri.title,
      adimSayisi: oneri.steps.length,
    }));
    const uyari = sonuc.dusurulen.length === 0
      ? `${sonuc.oneriler.length} öneri üretildi`
      : `${sonuc.oneriler.length} öneri üretildi; ${sonuc.dusurulen.length} öneri düşürüldü: ${sonuc.dusurulen.map((o) => `${o.title} (${o.sebep})`).join(', ')}`;
    return basarili({ oneriler: tablo, dusurulen: sonuc.dusurulen }, uyari);
  });
}

export async function planAccept(a: { cwd: string; all?: boolean; ids?: string[] }): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    if (a.all === true && a.ids !== undefined) throw new KullanimHatasi('--all ve --ids birlikte kullanılamaz');
    if (a.all !== true && (a.ids === undefined || a.ids.length === 0)) {
      throw new KullanimHatasi('--all veya --ids gerekli');
    }
    const dizin = await dizinBul(a.cwd);
    const oneriler = await dizin.onerileriOku();
    const secilenKimlikler = new Set(a.all === true ? oneriler.map((oneri) => oneri.proposalId) : a.ids);
    const bulunan = new Set(oneriler.filter((oneri) => secilenKimlikler.has(oneri.proposalId)).map((oneri) => oneri.proposalId));
    const eksikler = [...secilenKimlikler].filter((id) => !bulunan.has(id));
    if (eksikler.length > 0) throw new KullanimHatasi(`Öneri bulunamadı: ${eksikler.join(', ')}`);
    const kabul = oneriler.filter((oneri) => secilenKimlikler.has(oneri.proposalId));
    const kalan = oneriler.filter((oneri) => !secilenKimlikler.has(oneri.proposalId));
    const testler = kabul.map(oneriyiTesteCevir);
    await Promise.all(testler.map(async (test) => dizin.testYaz(test)));
    await dizin.onerileriYaz(kalan);
    return basarili(testler, `${testler.length} öneri kabul edildi`);
  });
}
