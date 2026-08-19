# Tool tulis + kartu hasil (Fase 4)

Status: **terimplementasi** (Fase 4). Yang berubah dari rencana ini saat
ditulis kodenya dicatat di §5.6 dan §11 — bukan disunting diam-diam.
Lanjutan dari [rencana widget](apps-sdk-widgets-plan.md), yang §9-nya menyatakan
"tool tulis apa pun" di luar cakupan. Dokumen ini yang mencabut kalimat itu — dan
menetapkan syarat-syaratnya.
Diaudit terhadap `dreambooth @ main` dan `dreambooth-mcp @ main`, 2026-08-18.

---

## 1. Tujuan

Operator bisa bilang "bikinin filter yang hangat dan agak pudar" atau "duplikat
booth Bandung buat event Sabtu", dan itu benar-benar terjadi — bukan dibalas
instruksi cara melakukannya sendiri di dashboard.

**Prompt yang mengisi datanya, bukan form.** Ini yang membedakan fase ini dari
Fase 4 rencana widget (pencari sesi), yang memang form-dulu karena rentang
tanggal lebih enak diklik daripada diketik. Untuk membuat sesuatu, model sudah
punya semua nilainya dari kalimat operator; menampilkan form berarti menyuruh
mereka mengetik dua kali. Jadi UI di sini **hanya muncul sesudah** penulisan
terjadi, dan tugasnya cuma satu: membuktikan apa yang barusan dibuat.

Prinsip dari v1 yang tetap berlaku, tidak satu pun dilonggarkan:

1. Tidak ada logika bisnis di sini. Tool tulis membungkus route Studio yang
   sudah ada, sama seperti tool baca.
2. `content` teks wajib tetap ada. Claude dan Gemini tidak merender widget.
3. **Identitas bukan argumen.** Ini jadi jauh lebih tajam untuk tool tulis:
   ketiga handler POST menerima `ownerEmail` untuk jalur kolaborator. Tool MCP
   **tidak boleh** meneruskan field itu, dan skema argumennya tidak boleh
   memuatnya — kalau tidak, ia jadi jalan pintas menulis ke akun orang lain.
4. Kegagalan pulang sebagai `isError`, bukan error protokol.

---

## 2. Keadaan hari ini: tiga tembok, dan satu asimetri

### 2.1 Handler POST-nya cookie-only

`app/api/projects/route.ts:564`, `app/api/filters/route.ts:509`,
`app/api/frames/route.ts:734` memanggil `getServerSession(auth)`, bukan
`resolveAuthSession`. Header `Authorization` tidak pernah dilihat. Ini disengaja
dan ada catatannya di `app/api/projects/route.ts:308-313`.

### 2.2 Ada palang non-GET terpusat

`utils/resolveAuthSession.ts` menolak setiap metode selain GET dari token
ber-claim `token_use === "mcp_access"`. Palangnya benar dan sengaja ditaruh di
tengah — per-route opt-in berarti jaminannya cuma berlaku di route yang sempat
diingat orang.

### 2.3 Cuma ada satu scope

`lib/oauth/tokens.ts:28,135` — `DEFAULT_SCOPE = "booths:read"` dan
`SUPPORTED_SCOPES = [DEFAULT_SCOPE]`. Tidak ada kosakata untuk menulis, dan
layar persetujuan (`app/[locale]/oauth/consent/page.tsx:107-122`) menuliskan
"Change or delete anything" sebagai hal yang **tidak** bisa dilakukan, sebagai
teks mati.

### 2.4 Asimetrinya — ini bagian yang penting

Ada dua jenis token yang bisa sampai ke Studio atas nama operator:

| | Device flow (`connect_account`) | OAuth (`mcp_access`) |
|---|---|---|
| Umur | 1 tahun | 1 jam |
| Scope | tidak ada | `booths:read` |
| Bisa dicabut | tidak | ya, RFC 7009 (`/api/oauth/revoke`) |
| Terdaftar | tidak | ya, lewat refresh token |
| Palang non-GET §2.2 | **tidak kena** | kena |

Yang lebih lemah justru yang tidak dipalang. Satu-satunya alasan token device
flow belum pernah menulis apa pun adalah §2.1 — tembok yang kebetulan, bukan
kebijakan. Begitu §2.1 dibongkar untuk membuka jalan tool tulis, token satu
tahun tanpa pencabutan itu ikut mendapat akses tulis, dan tidak ada yang
menyadarinya karena tidak ada baris kode yang berubah untuk itu.

**Keputusan: tulis hanya lewat OAuth.** Lihat §3.

---

## 3. Keputusan auth

**Menulis butuh token `mcp_access` dengan scope `booths:write`. Token device
flow ditolak untuk semua metode selain GET, secara eksplisit.**

Ini membalik keadaan sekarang: hari ini palang menahan token yang sudah keras
dan meloloskan yang lunak. Sesudah ini, kemampuan menulis justru terikat pada
satu-satunya token yang berumur satu jam, punya scope, dan bisa dicabut.

Perubahan di Studio, tiga berkas:

1. `lib/oauth/tokens.ts` — `WRITE_SCOPE = "booths:write"`,
   `SUPPORTED_SCOPES = [DEFAULT_SCOPE, WRITE_SCOPE]`. `narrowScope` tidak
   berubah perilakunya: yang tidak dikenal tetap diabaikan, hasilnya tetap
   subset. Tanpa permintaan eksplisit, yang keluar tetap `booths:read` saja —
   klien lama tidak pernah diam-diam naik hak.
2. `utils/resolveAuthSession.ts` — palang §2.2 berubah dari "non-GET ditolak"
   jadi "non-GET ditolak kecuali `scope` memuat `booths:write`", **dan** cabang
   token tanpa `token_use` (device flow, telemetri booth) ditolak untuk non-GET
   pada route yang memilih ikut. Telemetri booth (`/api/print-event-log`,
   `/api/device-heartbeat`, `/api/booth-events/batch`) tidak boleh ikut rusak —
   karena itu penolakannya per-route lewat `allow`, bukan global. Komentar
   besar di `ResolveOptions` sudah memperingatkan persis soal ini.
3. `app/[locale]/oauth/consent/page.tsx` — daftar "It will be able to" /
   "It will not be able to" berhenti jadi teks mati dan dibangun dari scope yang
   diminta. Kalau `booths:write` ikut diminta, baris "Change or delete anything"
   pindah dari daftar bawah ke daftar atas, dengan kalimat yang menyebut
   **apa** yang bisa dibuat: "Create filters and duplicate booths". Yang tidak
   pernah pindah, apa pun scope-nya: memindahkan uang, menarik dana, refund,
   menghapus.

Lalu handler POST yang dibuka (§4) memakai `resolveAuthContext(request, { allow: ["cookie", "bearer"] })`
dan menolak `source === "bearer"` yang tidak bawa `booths:write`.

**Prasyarat yang tidak bisa ditawar:** ini semua berlaku hanya untuk jalur
OAuth. Selama `connect_account` masih jadi satu-satunya cara menyambung di
stdio, di transport itu tool tulis tidak akan pernah aktif — dan itu benar,
bukan kekurangan. Tool tulis hanya didaftarkan kalau request datang membawa
bearer sendiri; kalau tidak, ia tidak muncul di `tools/list` sama sekali,
sehingga model tidak pernah menjanjikan sesuatu yang pasti gagal.

Gerbang itu **tidak** memeriksa scope-nya, dan tidak bisa — lihat §5.6.

---

## 4. Cakupan tool — tiga, bukan "dan create yang lain"

| Tool | Membungkus | Kenapa masuk / tidak |
|---|---|---|
| `create_filter` | `POST /api/filters` | **Pilot.** Payload murni angka, tanpa berkas, tanpa geometri. Model bisa menerjemahkan "hangat dan agak pudar" jadi `adjustments` dengan benar. Salah bikin murah dibatalkan. |
| `duplicate_project` | `POST /api/projects?duplicate=true&id=` | Yang benar-benar diminta operator. Model cuma mengirim satu id; tidak ada config yang dikarang. Route-nya sudah ada dan sudah menangani penamaan `-copy`, `-copy-1` sendiri. |
| `create_project` | `POST /api/projects` | **Ditahan sampai pilot sehat.** Kalau jadi: argumennya `{ title, type }` saja, config diisi `defaultConfig`/`newConfig` di sisi Studio. Model yang mengarang config booth menghasilkan booth yang bootingnya aneh dan operator tidak tahu kenapa. |
| `create_frame` | — | **Tidak.** Frame butuh aset gambar di S3 lewat signed PUT `/api/upload`, plus `drawParams` geometri (`models/Frame.ts`, belasan `required: true`). Model tidak punya gambar untuk diunggah, dan mengarang koordinat frame berarti hasil cetak yang rusak di lapangan. Jalur yang benar untuk ini adalah Frame Studio (`POST /api/ai/frames/generate`), dan itu proyek sendiri — bukan satu tool MCP. |

Batas yang perlu ditulis di deskripsi `create_filter`: handler POST-nya hanya
menyalin `name`, `adjustments`, `isPublic`. `filterMode`, `lutData`, dan
`thumbnail` diabaikan — jadi tool ini membuat filter mode-adjustment saja.
Impor `.cube` tetap urusan dashboard, dan itu memang wajar: itu unggah berkas.

---

## 5. UI — satu kartu, dipakai bertiga

### 5.1 Kenapa cuma satu, dan kenapa tidak ada kartu konfirmasi

Godaannya adalah membuat kartu "Yakin mau membuat filter ini? [Batal] [Buat]".
Jangan, karena dua alasan.

**Pertama, widget hanya bisa dirender setelah tool selesai.** Kartu konfirmasi
sebelum penulisan berarti tool kedua yang tidak menulis apa-apa (`preview_filter`),
dua kali bolak-balik, dan satu tool tambahan di daftar yang tidak menjawab
pertanyaan siapa pun. Direktori menilai konektor dari daftar tool-nya.

**Kedua, konfirmasinya sudah ada dan bukan milik kita.** Setiap host MCP
menampilkan dialog persetujuan untuk tool yang tidak `readOnlyHint`, lengkap
dengan argumennya. Membuat kartu konfirmasi kedua berarti operator menyetujui
dua kali untuk satu tindakan, dan yang kedua terlihat seperti basa-basi —
persis cara melatih orang mengklik "ya" tanpa membaca.

Jadi: **satu widget, `ui://widget/write-result.html`, dipakai ketiga tool.**
Nol CSS baru — `db-card`, `db-title`, `db-sub`, `db-status`, `db-btn--ghost`,
`db-note`, `db-link` di `src/ui/tokens.ts` sudah cukup untuk semuanya. Kalau
sebuah kartu hasil butuh token baru, itu tanda kartunya kebanyakan kerja.

### 5.2 Anatomi

```
┌──────────────────────────────────────────────┐
│  ◆ Dreambooth                                │  brandMark(), sudah ada di shell.ts
│                                              │
│  ✓ Filter dibuat                             │  db-status--ok, 14px
│  Senja Hangat                                │  db-title
│  Kontras +12 · Suhu +18 · Vignette 20        │  db-sub, maks 4 nilai paling menonjol
│                                              │
│  ┌────────┐                                  │
│  │        │  ← swatch pratinjau, 72x48        │
│  └────────┘                                  │
│                                              │
│  Buka di dashboard →                         │  db-link
└──────────────────────────────────────────────┘
```

Untuk `duplicate_project`, badan yang sama tanpa swatch:

```
│  ✓ Booth diduplikat                          │
│  Bandung Expo-copy                           │
│  Disalin dari Bandung Expo · belum aktif     │
│  Buka di dashboard →                         │
```

Tidak ada tombol tindakan di kartu ini selain tautan. Tidak ada "Urungkan":
membatalkan berarti PUT atau DELETE, dan itu melebarkan scope tulis dari
"membuat" jadi "mengubah dan menghapus" demi satu tombol. Pembatalan hidup di
dashboard, dan tautannya ada di kartu.

### 5.3 Swatch pratinjau — satu-satunya kepintaran yang diizinkan

Swatch itu `<svg>` gradien inline dengan `filter:` CSS ditempelkan dari
`adjustments`. Nol permintaan jaringan, jadi CSP tetap kosong di kedua daftar
seperti semua widget lain.

```
brightness → brightness()   saturation → saturate()   sepia     → sepia()
contrast   → contrast()     hueRotate  → hue-rotate() grayscale → grayscale()
blur       → blur()         invert     → invert()
```

Yang **tidak** bisa dipratinjau, dan karena itu tidak boleh dibohongi:
sharpening, noise reduction, clarity, dehaze, texture, dan seluruh mode LUT.
Kalau `adjustments` memuat salah satunya, swatch tetap dirender dari yang bisa
dan di bawahnya muncul `db-note`: "Pratinjau tidak memuat penajaman dan reduksi
noise." Swatch yang diam-diam mengabaikan setengah filter lebih buruk daripada
tidak ada swatch.

### 5.4 State

Kartu ini hanya punya dua keadaan, dan itu memang inti dari desain minimalis
ini — tidak ada polling, tidak ada timer, tidak ada `setWidgetState`, karena
tidak ada yang berubah sesudah tool kembali.

| State | Tampilan |
|---|---|
| `ok` | seperti §5.2 |
| `error` | `db-status--err`, kalimat dari `StudioError`, tanpa tautan dashboard |

`db-spinner` tidak dipakai. Status "sedang berjalan" sudah ditangani host lewat
`openai/toolInvocation/invoking` — "Membuat filter…", "Menduplikat booth…",
maksimal 64 karakter, dipotong `truncate()` di `widgets.ts`.

### 5.5 Klien tanpa widget

Sama seperti sekarang: `structuredContent` untuk widget, objek yang sama
di-pretty-print sebagai teks `content` untuk Claude dan Gemini. Satu tambahan
kecil — sertakan URL dashboard di dalam objeknya, bukan cuma di HTML kartu,
supaya klien teks juga bisa menyodorkan tautannya.

### 5.6 Yang berubah saat dikerjakan: gerbang `tools/list`

Rencana ini menyatakan tool tulis tidak muncul di `tools/list` untuk koneksi
yang cuma `booths:read`. Saat kodenya ditulis, ternyata **server MCP tidak bisa
tahu scope sebuah token.** Access token itu JWE next-auth yang dienkripsi
dengan `NEXT_AUTH_SECRET` milik Studio; layanan ini tidak memegang kuncinya dan
tidak bisa membaca klaim `scope` di dalamnya. Menanyakannya ke Studio berarti
satu round trip di depan `tools/list` — panggilan paling murah yang dilakukan
klien — pada setiap request.

Jadi gerbangnya dibelah dua, dan pembagiannya disengaja:

| Yang diperiksa | Di mana | Hasil kalau gagal |
|---|---|---|
| Ini jalur OAuth, bukan device flow | `createServer`, dari `bearerAuth` | tool tidak ada di `tools/list` |
| Token ini punya `booths:write` | Studio, `resolveAuthSession` | 403 berkalimat, dirender kartu error |

Bagian yang benar-benar soal keamanan — token satu tahun tanpa pencabutan tidak
boleh menulis — dijaga di kedua tempat. Yang longgar cuma bagian kosmetiknya:
koneksi read-only tetap **melihat** tool-nya, dan baru tahu waktu memanggil.
Itu gagal dengan bersih, kalimatnya menyebut cara memperbaikinya, dan
harganya nol round trip. Baris di §10 sudah disesuaikan.

### 5.7 Yang berubah saat ditinjau: duplikat itu **aktif**, dan slug-nya dibuang

Dokumen ini, deskripsi tool, README dan uji kasus 7 di `chatgpt-listing.md`
semuanya bilang salinan booth dibuat **tidak aktif**. Itu salah. Cabang
duplicate menyebar `...sourceProject.toObject()`, dan sumbernya dicari dengan
`isActive: true`, jadi salinannya ikut aktif. `isActive` di `models/Project.ts`
memang bukan sakelar hidup/mati — nilainya `default: true` dan fungsinya
soft-delete. Salinan dengan `isActive: false` justru akan terbaca sebagai
terhapus. Jadi yang diperbaiki kalimatnya, bukan kodenya. Mockup di §5.2 masih
menggambar "belum aktif"; yang benar adalah kartu itu merender apa pun yang
dikembalikan Studio, dan untuk duplikat nilainya selalu aktif.

Yang **memang** diperbaiki di kode: salinan tidak lagi mewarisi `slug` sumber.
`slug` itu alamat publik booth (`/api/projects/by-slug`) dan dideklarasikan
`unique, sparse`. Menyebarnya dari sumber berarti salah satu dari dua hal —
`save()` melempar duplicate key, atau, kalau indeks itu tidak pernah dibangun
di database ini, dua proyek menjawab satu URL publik dan salinannya menutupi
booth aslinya. Setiap booth kelahiran `/new` punya slug, jadi ini kasus biasa,
bukan kasus pinggir. Perbaikannya ada di Studio (`app/api/projects/route.ts`),
bukan di sini, karena tombol duplicate di dashboard memanggil route yang sama
dan bugnya sudah ada di sana sejak sebelum tool ini.

---

## 6. Anotasi dan konsekuensi listing

Tool tulis membawa anotasi yang jujur, dan ini bukan formalitas — kedua
direktori memeriksanya, dan host memakainya untuk memutuskan apakah boleh
auto-approve:

```ts
annotations: {
  readOnlyHint: false,
  destructiveHint: false,   // membuat, tidak menimpa dan tidak menghapus
  idempotentHint: false,    // dipanggil dua kali = dua filter
  openWorldHint: true,
}
```

`README.md` dan `docs/chatgpt-listing.md:31,153` sekarang menyatakan **setiap**
tool read-only, dan baris 153 khusus menjanjikan konektor akan bilang "tidak
bisa" kalau diminta mengubah sesuatu. Itu harus diperbarui berbarengan dengan
rilis, bukan sesudahnya: klaim listing yang lebih ketat daripada perilakunya
adalah masalah kepercayaan, bukan masalah dokumentasi. Yang tetap benar dan
harus tetap tertulis: konektor tidak bisa memindahkan uang, menarik dana,
melakukan refund, atau menghapus apa pun.

`server.json` naik versi. Entri registry tidak bisa dicabut dan tiap versi
kekal — perubahan daftar tool berarti versi baru, bukan sunting versi lama.

---

## 7. Pertanyaan terbuka

**Pemanggilan ganda.** `idempotentHint: false` itu jujur, tapi model yang
mengulang panggilan setelah timeout akan membuat dua filter dengan nama sama.
Tempat yang benar untuk memperbaikinya adalah Studio — `POST /api/filters`
menolak nama yang sudah dipakai owner yang sama dengan 409 — bukan pengecekan
di sisi MCP, yang akan jadi sumber kebenaran kedua dan tetap balapan.
Belum diputuskan; tidak memblokir pilot.

**Rentang `adjustments`.** ~~Belum diketahui.~~ **Terjawab.** Sumbernya
`adjustmentRanges` di `app/[locale]/dashboard/filters/[id]/page.tsx` — bukan
`models/Filter.ts`, yang cuma bilang `Number` tanpa batas. Tiga kelompok:
`brightness`/`contrast`/`saturation` 0–200 dengan 100 = tidak berubah,
`temperature`/`exposure`/`shadows` dan kawan-kawan -100–100 dengan 0 = tidak
berubah, dan `blur` 0–10 dalam piksel. Semuanya masuk ke `inputSchema`
`create_filter`, bukan cuma ke deskripsi: model sedang menerjemahkan "agak
pudar" jadi angka dan tidak punya pegangan lain. Salah skala menghasilkan
filter yang berhasil dibuat dan rusak dilihat — kegagalan yang tidak melaporkan
apa pun.

---

## 8. Yang bukan cakupan

- Mengubah dan menghapus. Scope `booths:write` fase ini berarti **membuat**;
  PUT dan DELETE tetap tertutup untuk bearer.
- `create_frame`, unggah berkas apa pun, impor `.cube`.
- Tool tulis di transport stdio / device flow (§3).
- Tombol "Urungkan" di kartu (§5.2).
- Uang, dalam bentuk apa pun. Ini permanen, bukan penundaan.

---

## 9. Urutan kerja

| # | Pekerjaan | Repo | Status |
|---|---|---|---|
| 0 | Baca skala `adjustments` dari renderer booth (§7) | dreambooth | selesai |
| 1 | `booths:write` di `SUPPORTED_SCOPES`, layar consent digerakkan scope | dreambooth | selesai |
| 2 | Palang non-GET jadi berbasis scope; device flow ditolak per-route | dreambooth | selesai |
| 3 | `POST /api/filters` menerima bearer ber-scope tulis | dreambooth | selesai |
| 4 | `StudioClient.post()` — sebelumnya cuma ada `get`/`getPublic` | dreambooth-mcp | selesai |
| 5 | Widget `write-result` + `create_filter`, terdaftar hanya di jalur bearer | dreambooth-mcp | selesai (§5.6) |
| 6 | `POST /api/projects?duplicate` menerima bearer + `duplicate_project` | keduanya | selesai |
| 7 | README, `chatgpt-listing.md`, `server.json` v0.2.0 | dreambooth-mcp | selesai |
| 8 | `create_project` minimal, kalau masih diinginkan | keduanya | **belum, sengaja** |

Nomor 6 dikerjakan berbarengan dengan 5, bukan sesudah pilotnya terbukti sehat
di lapangan. Alasannya: keduanya memakai gerbang, palang, kartu dan jalur error
yang persis sama, jadi menundanya tidak menghasilkan bukti baru — yang
menghasilkan bukti adalah operator sungguhan memakainya, dan itu belum terjadi
untuk keduanya. Nomor 8 tetap ditahan; alasannya di §4 dan sekarang juga
ditegakkan oleh Studio (403 kalau bearer memanggil cabang non-duplicate).

---

## 10. Daftar periksa verifikasi

Yang bertanda [x] punya tes otomatis yang menjaganya; yang kosong butuh Studio
yang benar-benar jalan, dan tidak ada satu pun yang sudah dijalankan melawan
deployment sungguhan.

- [x] Tanpa bearer: `create_filter` dan `duplicate_project` **tidak muncul** di
      `tools/list`; tool baca tidak terpengaruh.
      (`scripts/writeTools.test.ts`, plus `tools/list` sungguhan lewat curl.)
- [x] Token `booths:read` memanggil POST di route yang opt-in: ditolak.
      (`tests/oauth/bearerPolicy.test.ts` di repo Studio.)
- [x] Token `booths:write` di route yang **tidak** opt-in: tetap ditolak.
- [x] Token device flow di route yang opt-in: ditolak (`unscoped`).
- [x] Telemetri booth (`/api/device-heartbeat`, `/api/print-event-log`,
      `/api/booth-events/batch`) masih menerima POST bearer — armada tidak mati.
- [x] `ownerEmail` tidak ada di skema argumen tool mana pun, tidak pernah
      diteruskan walau model mengarangnya, dan ditolak Studio kalau tetap
      sampai.
- [x] Kegagalan tulis kembali sebagai `isError` berkalimat, membawa kalimat
      Studio sendiri, dan **tidak pernah** `retryable` — termasuk pada 5xx.
- [x] `create_filter` melaporkan yang disimpan Studio, bukan yang dikirim.
- [x] Kartu dirender di Chromium untuk empat state (filter, filter dengan efek
      tak terpratinjau, booth, gagal) di terang dan gelap, tanpa error konsol.
      Lihat `npm run preview`.
- [ ] Filter yang dibuat lewat MCP muncul di dashboard dan bisa dipilih di
      pengaturan booth — bukan cuma ada di database.
- [ ] Booth hasil duplikat bisa dibuka di editor dan dinyalakan.
- [ ] Layar consent menampilkan baris "Create photo filters…" saat
      `booths:write` diminta, dan tidak menampilkannya kalau tidak.
- [ ] Claude Desktop: kartu tidak dirender, teks berisi nama filter dan
      tautan dashboard.
- [ ] `npm run inspect` dan `inspect:http` hijau tanpa token. **Belum bisa
      diuji di sini** — sandbox memblokir `dreamboothstudio.com` di level
      proxy, jadi `search_docs` gagal 403 di kedua smoke, sama persis di commit
      sebelum perubahan ini.
