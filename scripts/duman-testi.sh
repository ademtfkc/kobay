#!/usr/bin/env bash
# Duman testi: kobay'ı paketle, temiz bir dizine kur ve kurulan paketle
# gerçek bir keşif turu at. Beyin çağrısı yok (sahte adaptör).
#
# Çalıştırma: npm run duman
set -euo pipefail

KOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BEKLENEN_SAYFA=4
GECICI=""
SUNUCU_PID=""

adim() { printf '\n== %s\n' "$1"; }
hata() { printf '\nDUMAN TESTİ DÜŞTÜ: %s\n' "$1" >&2; exit 1; }

temizle() {
  local kod=$?
  if [ -n "$SUNUCU_PID" ] && kill -0 "$SUNUCU_PID" 2>/dev/null; then
    kill "$SUNUCU_PID" 2>/dev/null || true
    wait "$SUNUCU_PID" 2>/dev/null || true
  fi
  if [ -n "$GECICI" ] && [ -d "$GECICI" ]; then
    rm -rf "$GECICI"
  fi
  return $kod
}
trap temizle EXIT

[ -f "$KOK/dist/cli/index.js" ] || hata "dist yok; önce 'npm run build' çalıştır"

GECICI="$(mktemp -d "${TMPDIR:-/tmp}/kobay-duman-XXXXXX")"
adim "Geçici dizin: $GECICI"

adim "npm pack"
TGZ="$(cd "$KOK" && npm pack --json --pack-destination "$GECICI" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["filename"])')"
[ -f "$GECICI/$TGZ" ] || hata "paket üretilemedi: $TGZ"
printf 'paket: %s (%s bayt)\n' "$TGZ" "$(wc -c < "$GECICI/$TGZ" | tr -d ' ')"

adim "Paket içeriği denetimi"
tar -tzf "$GECICI/$TGZ" | sed 's|^package/||' > "$GECICI/icerik.txt"
for beklenen in dist/cli/index.js beceri/SKILL.md schemas/plan.schema.json test/kobay-demo/sunucu.mjs README.md LICENSE package.json; do
  grep -qx "$beklenen" "$GECICI/icerik.txt" || hata "pakette eksik: $beklenen"
done
if grep -q '^src/' "$GECICI/icerik.txt"; then
  hata "pakete kaynak dosyası girmiş"
fi
if grep '^test/' "$GECICI/icerik.txt" | grep -qvx 'test/kobay-demo/sunucu.mjs'; then
  hata "pakete demo sunucusu dışında test dosyası girmiş"
fi
if grep -qE '\.(d\.ts|js\.map)$' "$GECICI/icerik.txt"; then
  hata "pakete bildirim veya kaynak haritası girmiş"
fi
printf 'içerik tamam (%s dosya)\n' "$(wc -l < "$GECICI/icerik.txt" | tr -d ' ')"

adim "Temiz dizine kurulum"
KURULUM="$GECICI/kurulum"
mkdir -p "$KURULUM"
( cd "$KURULUM" && npm init -y >/dev/null && npm install "$GECICI/$TGZ" --no-audit --no-fund --loglevel=error >/dev/null )
[ -x "$KURULUM/node_modules/.bin/kobay" ] || hata "kobay komutu kurulmadı"

adim "npx kobay --version"
SURUM="$( cd "$KURULUM" && npx kobay --version )"
printf '%s\n' "$SURUM"
if [ -z "$SURUM" ]; then
  DOGRUDAN="$( cd "$KURULUM" && node node_modules/kobay/dist/cli/index.js --version || true )"
  if [ -n "$DOGRUDAN" ]; then
    hata "kurulu 'kobay' komutu sessiz: doğrudan node çağrısı $DOGRUDAN veriyor ama bin symlink'i hiçbir şey yapmıyor. src/cli/index.ts içindeki dogrudanCalisiyor kontrolü process.argv[1]'i realpath'e çevirmiyor."
  fi
  hata "sürüm boş döndü"
fi

adim "Kurulu paketin Playwright sürümü için Chromium (kobay install-browser)"
# Temiz kurulum ^semver aralığından depodakinden farklı bir Playwright çözebilir; tarayıcıyı
# depo kopyasıyla değil, kurulu paketin kendi komutuyla kur ve denetimi o kuruluma göre yap.
PW_KURULU="$(cd "$KURULUM" && node -p 'require(require.resolve("@playwright/test/package.json", { paths: [require.resolve("kobay/package.json")] })).version')"
PW_DEPO="$(cd "$KOK" && node -p 'require("@playwright/test/package.json").version')"
printf 'Playwright: kurulu %s, depo %s\n' "$PW_KURULU" "$PW_DEPO"
( cd "$KURULUM" && npx kobay install-browser ) > "$GECICI/tarayici.log" 2>&1 \
  || hata "kobay install-browser başarısız: $(tail -n 20 "$GECICI/tarayici.log")"
( cd "$KURULUM" && node --input-type=module -e '
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
const kobay = createRequire(import.meta.url).resolve("kobay/package.json");
const pw = createRequire(kobay)("@playwright/test");
const yol = pw.chromium.executablePath();
if (!existsSync(yol)) { console.error("Chromium yok: " + yol); process.exit(1); }
console.log("Chromium: " + yol);
' ) || hata "kurulu paketin Playwright'ı Chromium bulamadı"

adim "npx kobay doctor"
DOKTOR="$( cd "$KURULUM" && npx kobay doctor )" || hata "doctor sıfırdan farklı kodla döndü"
printf '%s\n' "$DOKTOR"
printf '%s' "$DOKTOR" | grep -q '✓ Node' || hata "doctor Node kontrolünü geçmedi"
printf '%s' "$DOKTOR" | grep -q '✓ Chromium' || hata "doctor Chromium bulamadı"

adim "Kurulu paketten kobay demo (geçici port)"
( cd "$KURULUM" && ./node_modules/.bin/kobay demo --port 0 ) > "$GECICI/sunucu.log" 2>&1 &
SUNUCU_PID=$!
URL=""
for _ in $(seq 1 50); do
  URL="$(sed -n 's/^Kobay demo: //p' "$GECICI/sunucu.log" 2>/dev/null | head -n 1)"
  case "$URL" in http*) break ;; *) URL=""; sleep 0.2 ;; esac
done
[ -n "$URL" ] || hata "demo sunucusu açılmadı: $(cat "$GECICI/sunucu.log")"
printf 'demo: %s\n' "$URL"

adim "kobay project create (beyin: sahte)"
PROJE="$GECICI/proje"
mkdir -p "$PROJE"
( cd "$KURULUM" && KOBAY_LOGIN_USER=demo KOBAY_LOGIN_PASS=demo123 npx kobay project create \
    --cwd "$PROJE" --url "$URL" --login --login-url "$URL/giris" --beyin sahte )

adim "kobay explore"
KESIF="$( cd "$KURULUM" && npx kobay explore --cwd "$PROJE" --output json )"
SAYFA="$(printf '%s' "$KESIF" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["data"]["sayfalar"]))')"
printf 'keşfedilen sayfa: %s (beklenen %s)\n' "$SAYFA" "$BEKLENEN_SAYFA"
[ "$SAYFA" = "$BEKLENEN_SAYFA" ] || hata "sayfa sayısı $BEKLENEN_SAYFA değil: $SAYFA"

adim "kobay project get"
( cd "$KURULUM" && npx kobay project get --cwd "$PROJE" )

printf '\nDUMAN TESTİ GEÇTİ\n'
