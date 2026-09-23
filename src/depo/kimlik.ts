import { randomBytes } from 'node:crypto';

function rastgeleKarakterler(uzunluk: number): string {
  const alfabe = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(randomBytes(uzunluk), (bayt) => alfabe[bayt % alfabe.length]).join('');
}

export function yeniTestId(): string {
  return `t_${rastgeleKarakterler(8)}`;
}

export function yeniRunId(): string {
  const simdi = new Date();
  const zaman = [
    simdi.getFullYear(),
    String(simdi.getMonth() + 1).padStart(2, '0'),
    String(simdi.getDate()).padStart(2, '0'),
    String(simdi.getHours()).padStart(2, '0'),
    String(simdi.getMinutes()).padStart(2, '0'),
    String(simdi.getSeconds()).padStart(2, '0'),
  ].join('');
  return `r_${zaman}_${rastgeleKarakterler(4)}`;
}
