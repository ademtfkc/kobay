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
URL=""

adim() { printf '\n== %s\n' "$1"; }
hata() { printf '\nDUMAN TESTİ DÜŞTÜ: %s\n' "$1" >&2; exit 1; }

windowsMu() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

pythonKomutu() {
  command -v python3 >/dev/null 2>&1 && { printf 'python3'; return; }
  command -v python >/dev/null 2>&1 && { printf 'python'; return; }
  hata "Python 3 bulunamadı"
}

KOBAY_NPX=(npx --no-install kobay)
PYTHON="$(pythonKomutu)"
# Gömülü Python blokları Türkçe karakter basıyor; Windows'ta boruya giden stdout
# cp1252 olur ve UnicodeEncodeError ile çöker. Kodlamayı sabitle.
export PYTHONIOENCODING=utf-8

iz() { printf 'temizlik: %s\n' "$1" >&2; }

# Süreç ölene dek en çok $2 saniye yoklar; ölürse 0, ölmezse 1 döner. Tavansız wait yok.
olumunuBekle() {
  local pid=$1 tavan=$2 i
  for ((i = 0; i < tavan * 5; i++)); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  ! kill -0 "$pid" 2>/dev/null
}

# Windows: MSYS yol çevirisi '/PID' gibi argümanları dosya yoluna çevirmesin.
taskkillCalistir() {
  local cikti kod=0
  cikti="$(MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' taskkill.exe /PID "$1" /T /F 2>&1)" || kod=$?
  iz "taskkill /PID $1 /T /F -> kod $kod: $(printf '%s' "$cikti" | tr '\r\n' '  ')"
  return $kod
}

# Windows: demo portunu dinleyen sürecin Windows PID'i (yoksa boş).
portunWindowsPidi() {
  local port=$1
  [ -n "$port" ] || return 0
  netstat.exe -ano -p TCP 2>/dev/null | tr -d '\r' \
    | awk -v p=":$port" '$1 == "TCP" && substr($2, length($2) - length(p) + 1) == p && $3 ~ /:0$/ { print $5; exit }' \
    | grep -E '^[0-9]+$' || true
}

# Unix: $1 ve onun tüm torunları (yalnız bu betiğin başlattığı ağaç), kök önce.
altAgac() {
  local c
  printf '%s\n' "$1"
  for c in $(pgrep -P "$1" 2>/dev/null || true); do
    altAgac "$c"
  done
}

# Unix: ağacı önce kibarca (TERM), $2 sn içinde kapanmazsa zorla (KILL) kapatır.
temizleUnix() {
  local pid p kalan i
  local -a hepsi=()
  while IFS= read -r p; do hepsi+=("$p"); done < <(altAgac "$1")
  for p in "${hepsi[@]}"; do kill "$p" 2>/dev/null || true; done
  for ((i = 0; i < $2 * 5; i++)); do
    kalan=0
    for p in "${hepsi[@]}"; do kill -0 "$p" 2>/dev/null && kalan=1; done
    [ "$kalan" = 0 ] && return 0
    sleep 0.2
  done
  for p in "${hepsi[@]}"; do
    if kill -0 "$p" 2>/dev/null; then
      iz "süreç $p kibar sinyale uymadı; KILL"
      kill -9 "$p" 2>/dev/null || true
    fi
  done
  return 0
}

temizleWindows() {
  local winpid="" port="" dinleyen
  if [ -r "/proc/$SUNUCU_PID/winpid" ]; then
    winpid="$(tr -dc '0-9' < "/proc/$SUNUCU_PID/winpid" 2>/dev/null || true)"
  fi
  port="$(printf '%s' "$URL" | grep -oE '[0-9]+$' || true)"
  iz "MSYS PID $SUNUCU_PID, Windows PID '${winpid:-bulunamadı}', demo portu '${port:-bilinmiyor}'"
  if [ -n "$winpid" ] && [ "$winpid" != "0" ]; then
    taskkillCalistir "$winpid" || iz "Windows PID ile sonlandırma başarısız"
  else
    iz "Windows PID bulunamadı; süreç ağacı öldürme atlandı (MSYS PID taskkill'e verilmez)"
  fi
  # Yedek: sunucu hâlâ portu dinliyorsa dinleyen süreci doğrudan sonlandır.
  dinleyen="$(portunWindowsPidi "$port")"
  if [ -n "$dinleyen" ] && [ "$dinleyen" != "0" ] && [ "$dinleyen" != "4" ]; then
    iz "port $port hâlâ dinleniyor (Windows PID $dinleyen); yedek yol"
    taskkillCalistir "$dinleyen" || iz "port üzerinden sonlandırma başarısız"
  elif [ -n "$port" ]; then
    iz "port $port dinlenmiyor"
  fi
}

temizle() {
  local kod=$?
  if [ -n "$SUNUCU_PID" ] && kill -0 "$SUNUCU_PID" 2>/dev/null; then
    if windowsMu; then
      # Git Bash'in kill'i yalnız npm/npx sarmalayıcısını kapatabilir; demo Node
      # sunucusunu ve çocuklarını Windows PID'iyle süreç ağacı olarak sonlandır.
      temizleWindows
    else
      temizleUnix "$SUNUCU_PID" 10
    fi
    if olumunuBekle "$SUNUCU_PID" 15; then
      wait "$SUNUCU_PID" 2>/dev/null || true
    else
      iz "sunucu süreci (MSYS/PID $SUNUCU_PID) 15 sn içinde kapanmadı; beklemeden çıkılıyor"
    fi
  fi
  if [ -n "$GECICI" ] && [ -d "$GECICI" ]; then
    rm -rf "$GECICI" || iz "geçici dizin silinemedi: $GECICI"
  fi
  return $kod
}
trap temizle EXIT

[ -f "$KOK/dist/cli/index.js" ] || hata "dist yok; önce 'npm run build' çalıştır"

GECICI="$(mktemp -d "${TMPDIR:-/tmp}/kobay-duman-XXXXXX")"
adim "Geçici dizin: $GECICI"

adim "npm pack"
PAKET_JSON="$(cd "$KOK" && npm pack --json --pack-destination "$GECICI" 2>"$GECICI/pack.err")" \
  || hata "npm pack başarısız: $(tail -n 20 "$GECICI/pack.err")"
TGZ="$(printf '%s' "$PAKET_JSON" | "$PYTHON" -c 'import json,sys; print(json.load(sys.stdin)[0]["filename"])')" \
  || hata "npm pack --json çıktısı ayrıştırılamadı: $PAKET_JSON $(tail -n 20 "$GECICI/pack.err")"
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
if windowsMu; then
  [ -f "$KURULUM/node_modules/.bin/kobay.cmd" ] || hata "kobay.cmd komutu kurulmadı"
else
  [ -x "$KURULUM/node_modules/.bin/kobay" ] || hata "kobay komutu kurulmadı"
fi

adim "kobay --version"
SURUM="$( cd "$KURULUM" && "${KOBAY_NPX[@]}" --version )"
printf '%s\n' "$SURUM"
if [ -z "$SURUM" ]; then
  DOGRUDAN="$( cd "$KURULUM" && node node_modules/@ademtfkc/kobay/dist/cli/index.js --version || true )"
  if [ -n "$DOGRUDAN" ]; then
    hata "kurulu 'kobay' komutu sessiz: doğrudan node çağrısı $DOGRUDAN veriyor ama bin symlink'i hiçbir şey yapmıyor. src/cli/index.ts içindeki dogrudanCalisiyor kontrolü process.argv[1]'i realpath'e çevirmiyor."
  fi
  hata "sürüm boş döndü"
fi

adim "Kurulu paketin Playwright sürümü için Chromium (kobay install-browser)"
# Temiz kurulum ^semver aralığından depodakinden farklı bir Playwright çözebilir; tarayıcıyı
# depo kopyasıyla değil, kurulu paketin kendi komutuyla kur ve denetimi o kuruluma göre yap.
PW_KURULU="$(cd "$KURULUM" && node -p 'require(require.resolve("@playwright/test/package.json", { paths: [require.resolve("@ademtfkc/kobay/package.json")] })).version')"
PW_DEPO="$(cd "$KOK" && node -p 'require("@playwright/test/package.json").version')"
printf 'Playwright: kurulu %s, depo %s\n' "$PW_KURULU" "$PW_DEPO"
( cd "$KURULUM" && "${KOBAY_NPX[@]}" install-browser ) > "$GECICI/tarayici.log" 2>&1 \
  || hata "kobay install-browser başarısız: $(tail -n 20 "$GECICI/tarayici.log")"
( cd "$KURULUM" && node --input-type=module -e '
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
const kobay = createRequire(import.meta.url).resolve("@ademtfkc/kobay/package.json");
const pw = createRequire(kobay)("@playwright/test");
const yol = pw.chromium.executablePath();
if (!existsSync(yol)) { console.error("Chromium yok: " + yol); process.exit(1); }
console.log("Chromium: " + yol);
' ) || hata "kurulu paketin Playwright'ı Chromium bulamadı"

adim "kobay doctor"
DOKTOR="$( cd "$KURULUM" && "${KOBAY_NPX[@]}" doctor )" || hata "doctor sıfırdan farklı kodla döndü"
printf '%s\n' "$DOKTOR"
printf '%s' "$DOKTOR" | grep -q '✓ Node' || hata "doctor Node kontrolünü geçmedi"
printf '%s' "$DOKTOR" | grep -q '✓ Chromium' || hata "doctor Chromium bulamadı"

adim "Kurulu paketten kobay demo (geçici port)"
if windowsMu; then
  ( cd "$KURULUM" && "${KOBAY_NPX[@]}" demo --port 0 ) > "$GECICI/sunucu.log" 2>&1 &
  SUNUCU_PID=$!
else
  # exec: alt kabuk npm'in kendisi olur, aradaki kabuk kalmaz. disown: bash'in
  # "Terminated" iş bildirimi çıkmaz (temizlik kill -0 ile yoklar, wait'e gerek yok).
  ( cd "$KURULUM" && exec "${KOBAY_NPX[@]}" demo --port 0 ) > "$GECICI/sunucu.log" 2>&1 &
  SUNUCU_PID=$!
  disown "$SUNUCU_PID" 2>/dev/null || true
fi
URL=""
for _ in $(seq 1 50); do
  # Satır önekinden bağımsız: günlükteki ilk loopback adresini al.
  # `|| true`: eşleşme yoksa grep 1 döner, `set -e` betiği sessizce öldürürdü.
  URL="$(grep -oE 'https?://127\.0\.0\.1:[0-9]+' "$GECICI/sunucu.log" 2>/dev/null | head -n 1 || true)"
  case "$URL" in http*) break ;; *) URL=""; sleep 0.2 ;; esac
done
[ -n "$URL" ] || hata "demo sunucusu açılmadı: $(cat "$GECICI/sunucu.log")"
printf 'demo: %s\n' "$URL"

adim "Demo sayfaları İngilizce mi (4 sayfa, ASCII dışı karakter yok)"
CEREZ="$GECICI/cerez.txt"
curl -fsS -c "$CEREZ" -o "$GECICI/sayfa-1-login.html" "$URL/login" || hata "/login alınamadı"
curl -fsS -c "$CEREZ" -b "$CEREZ" -o /dev/null --data 'username=demo&password=demo123' "$URL/login" \
  || hata "demo girişi başarısız"
curl -fsS -b "$CEREZ" -o "$GECICI/sayfa-2-panel.html" "$URL/" || hata "/ alınamadı"
curl -fsS -b "$CEREZ" -o "$GECICI/sayfa-3-records.html" "$URL/records" || hata "/records alınamadı"
curl -fsS -b "$CEREZ" -o "$GECICI/sayfa-4-new.html" "$URL/new" || hata "/new alınamadı"
"$PYTHON" - "$GECICI" <<'PY' || hata "demo sayfa denetimi düştü (sebep yukarıdaki Python çıktısında)"
import glob, re, sys
dizin = sys.argv[1]
yollar = sorted(glob.glob(dizin + '/sayfa-*.html'))
if len(yollar) != 4:
    print('beklenen 4 sayfa, bulunan %d' % len(yollar)); sys.exit(1)
basliklar, kotu = [], []
for yol in yollar:
    metin = open(yol, encoding='utf-8').read()
    disi = sorted({k for k in metin if ord(k) > 127})
    if disi:
        kotu.append('%s: %s' % (yol.rsplit('/', 1)[-1], ''.join(disi)))
    esles = re.search(r'<title>(.*?)</title>', metin)
    basliklar.append(esles.group(1) if esles else '(başlıksız)')
if kotu:
    print('ASCII dışı karakter: ' + ' | '.join(kotu)); sys.exit(1)
beklenen = ['Login', 'Dashboard', 'Record List', 'New Record']
if basliklar != beklenen:
    print('başlıklar %s, beklenen %s' % (basliklar, beklenen)); sys.exit(1)
print('başlıklar: ' + ', '.join(basliklar) + ' (ASCII dışı karakter: 0)')
PY

adim "kobay project create (beyin: sahte)"
PROJE="$GECICI/proje"
mkdir -p "$PROJE"
( cd "$KURULUM" && KOBAY_LOGIN_USER=demo KOBAY_LOGIN_PASS=demo123 "${KOBAY_NPX[@]}" project create \
    --cwd "$PROJE" --url "$URL" --login --login-url "$URL/login" --beyin sahte )

adim "kobay explore"
KESIF="$( cd "$KURULUM" && "${KOBAY_NPX[@]}" explore --cwd "$PROJE" --output json )"
SAYFA="$(printf '%s' "$KESIF" | "$PYTHON" -c 'import json,sys; print(len(json.load(sys.stdin)["data"]["pages"]))')"
printf 'keşfedilen sayfa: %s (beklenen %s)\n' "$SAYFA" "$BEKLENEN_SAYFA"
[ "$SAYFA" = "$BEKLENEN_SAYFA" ] || hata "sayfa sayısı $BEKLENEN_SAYFA değil: $SAYFA"

adim "kobay project get"
( cd "$KURULUM" && "${KOBAY_NPX[@]}" project get --cwd "$PROJE" )

adim "kobay test report --all (kurulu paketten HTML rapor)"
RAPOR="$( cd "$KURULUM" && "${KOBAY_NPX[@]}" test report --all --cwd "$PROJE" --output json )" \
  || hata "test report sıfırdan farklı kodla döndü: $RAPOR"
# indexPath Windows'ta yerel yol (C:\...): varlığını Python denetler, kabuk MSYS yolunu kullanır.
RAPOR_INDEX="$(printf '%s' "$RAPOR" | "$PYTHON" -c 'import json,os,sys; z=json.load(sys.stdin); assert z["ok"] is True; assert os.path.isfile(z["data"]["indexPath"]); print(z["data"]["indexPath"])')" \
  || hata "test report zarfı beklenen biçimde değil ya da index.html yok: $RAPOR"
[ -f "$PROJE/.kobay/report/index.html" ] || hata "rapor .kobay/report/index.html altında değil"
[ -f "$PROJE/.kobay/report/kobay-report.json" ] || hata "rapor işaret dosyası yok"
grep -q 'Content-Security-Policy' "$PROJE/.kobay/report/index.html" || hata "raporda CSP yok"
printf 'rapor: %s\n' "$RAPOR_INDEX"

printf '\nDUMAN TESTİ GEÇTİ\n'
