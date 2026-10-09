/**
 * Adresteki kullanıcı bilgisini (`http://admin:parola@host`) rapordan çıkarır:
 * `http://[redacted]@host/…`. Ayrıştırılamayan ama `@` içeren değer bütünüyle
 * `[redacted]` olur (güvenli taraf); kullanıcı bilgisi yoksa adres aynen kalır.
 */
export function adresKimligiGizle(adres: string): string {
  const ayrismaz = (): string => (adres.includes('@') ? '[redacted]' : adres);
  let url: URL;
  try {
    url = new URL(adres);
  } catch {
    return ayrismaz();
  }
  // `admin:parola@host` gibi şemasız değeri `new URL` "admin:" şemalı sayar ve kullanıcı
  // alanı boş kalır: http(s) dışındaki her şema ayrıştırılamamış sayılır.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ayrismaz();
  if (url.username === '' && url.password === '') return adres;
  // Yazılışı koru (sondaki `/` eklenmez); yalnız kullanıcı bilgisi değişir.
  const korunan = adres.replace(/^(\s*https?:\/\/)[^/?#]*@/i, '$1[redacted]@');
  if (korunan !== adres) return korunan;
  return `${url.protocol}//[redacted]@${url.host}${url.pathname}${url.search}${url.hash}`;
}

/**
 * Serbest metindeki her `http(s)://kullanıcı:parola@host` ve `ws(s)://…` parçasının
 * kullanıcı bilgisini `[redacted]` yapar; metnin geri kalanı aynen kalır.
 */
export function metindekiKimligiGizle(metin: string): string {
  return metin.replace(/\b(https?|wss?):\/\/[^/?#\s]*@/gi, '$1://[redacted]@');
}
