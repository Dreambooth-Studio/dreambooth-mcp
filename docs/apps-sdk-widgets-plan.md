# Widget UI di ChatGPT (Apps SDK)

Status: **rencana**, implementasi Fase 0–2 sedang berjalan di `feat/apps-sdk-widgets`.
Lanjutan dari [desain v1](../../dreambooth-prod/docs/dreambooth-mcp-design.md) di repo Studio.
Referensi Apps SDK diaudit terhadap `developers.openai.com/apps-sdk`, 2026-08-11.
Konvensi UI diaudit terhadap `dreambooth-prod @ main` (`tailwind.config.js`, `app/components/ui/`, `app/[locale]/dashboard/`).

---

## 1. Tujuan

Tool MCP hari ini balikin JSON mentah yang di-render model jadi paragraf. Yang kita mau: kartu Dreambooth **beneran** muncul inline di ChatGPT — picker booth, rentang tanggal, tombol, angka omzet — persis pola yang dipakai app pihak ketiga (Traveloka dkk.).

Mekanismenya bukan fitur khusus: tool balikin `_meta` yang nunjuk ke sebuah **UI resource** (HTML, mimetype `text/html;profile=mcp-app`), ChatGPT render di iframe sandbox, dan widget bisa manggil balik tool lewat `window.openai.callTool()`. Server MCP-nya tetap server yang sama.

**Prinsip yang dibawa dari v1 dan tidak boleh dilanggar:**

1. Widget **tidak boleh** jadi sumber kebenaran kedua. Tidak ada agregasi, tidak ada perhitungan omzet di dalam widget — dia cuma merender apa yang dibalikin Studio.
2. `content` teks **wajib tetap ada** di setiap hasil tool. Claude dan Gemini tidak merender widget; mereka jatuh ke teks itu. Widget adalah lapisan tambahan, bukan pengganti.
3. Identitas tetap bukan argumen. Widget juga tidak boleh mengirim `email`/`userId` lewat `callTool`.
4. Read-only. Tidak ada widget yang menulis apa pun di fase ini.

---

## 2. Fase 0 — de-risk (WAJIB duluan, sebelum satu baris UI pun ditulis)

Ada satu asumsi yang kalau salah bikin seluruh rencana ini sia-sia, dan sekarang belum pernah diuji.

### 2.1 Apakah ChatGPT memakai ulang `Mcp-Session-Id` antar giliran?

Token operator disimpan **per sesi, di memori** (`src/http.ts`). Kalau klien re-`initialize` tiap request, tiap giliran dapat `SessionTokens` kosong dan operator kelihatan "belum connect" selamanya — mereka akan disuruh device flow berulang-ulang.

Cara uji: pasang connector di ChatGPT developer mode, ajukan tiga pertanyaan berturut-turut, panggil `session_info`, bandingkan `sessionId`-nya. **Sama = lulus. Berubah = gagal.** Log `session opened` di Railway memberi jawaban yang sama.

Kalau gagal → auth harus pindah ke OAuth 2.1 dulu (§8), dan rencana widget mundur ke belakangnya.

### 2.2 Apakah `callTool` dari widget mendarat di sesi yang sama?

Ini yang menentukan apakah widget bisa ambil data sendiri (misal isi dropdown booth) atau cuma boleh merender apa yang sudah dikirim tool pertama. Uji dengan `session_info` yang dipanggil sekali oleh model dan sekali oleh widget, lalu bandingkan `sessionId`.

`session_info` bersifat sementara — hapus setelah kedua pertanyaan di atas terjawab. Dia sengaja tidak membocorkan token, hanya id sesi dan status auth.

### 2.3 Sesi tidak pernah kedaluwarsa

`createdAt` ditulis saat sesi dibuat dan tidak pernah dibaca. Sesi cuma hilang saat `close` atau restart. Begitu widget dipakai orang luar, ini jadi kebocoran memori sekaligus kebocoran token: token session-equivalent menganggur di RAM tanpa batas waktu. Sweep menghapus sesi yang idle > 30 menit.

**Keluaran Fase 0:** jawaban untuk 2.1 dan 2.2, plus sweep 2.3 sudah merge. Baru lanjut.

---

## 3. Sistem desain — diambil dari website, bukan dikarang

Widget hidup di luar Next.js: tidak ada Tailwind, tidak ada React tree kita. Jadi token disalin manual sekali ke `src/ui/tokens.ts`, dengan komentar yang menunjuk sumbernya supaya ketahuan kalau menyimpang.

### 3.1 Warna (sumber: `dreambooth-prod/tailwind.config.js`)

| Peran | Hex | Nama di repo |
|---|---|---|
| Primary | `#007AFF` | `blueSparkle` / `primary` |
| Primary hover | `#0063D1` | `primary.hover` |
| Primary subtle | `#E6F1FF` | `primary.subtle` |
| Danger | `#DC2E49` | `anarchist` |
| Warning (teks) | `#B45309` | `warning.ink` — **wajib** untuk teks amber, `warning.DEFAULT` gagal WCAG AA |
| Success | `#025E4A` | `scifiTakeout` |
| Teks utama | `#333333` | `carbon` |
| Teks sekunder | `#6B7280` | gray-500 |
| Garis kartu | `#E5E7EB` | gray-200 |
| Garis input | `#D1D5DB` | gray-300 |
| Permukaan hover | `#F9FAFB` | gray-50 |

Font: **Inter**, dengan fallback `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`. Jangan `@import` Google Fonts — kena CSP dan bikin FOUT di iframe; Inter sudah ada di hampir semua sistem, fallback-nya cukup.

### 3.2 Idiom komponen (frekuensi nyata di `app/[locale]/dashboard/`)

Ini bukan selera, ini yang memang dipakai:

```
Kartu     bg-white rounded-lg shadow-sm border border-gray-200 p-6   (dominan; rounded-lg 1088x, shadow-sm 212x)
Label     text-xs font-medium text-gray-500 mb-1
Input     border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white
          hover:bg-gray-50 focus:ring-2 focus:ring-blueSparkle
Tombol    px-4 py-2 text-sm font-medium text-white bg-blueSparkle rounded-lg
          hover:opacity-90 disabled:opacity-40
Chip      rounded-full border border-gray-200 bg-white px-3 py-1.5 text-sm hover:bg-gray-50
```

Padanan CSS-nya hidup di `src/ui/tokens.ts` sebagai `baseCss`. **Satu hal yang memang belum ada di website:** state "chip terpilih". Dashboard memfilter pakai dropdown (`SingleSelectDropdown`, `SearchableCheckboxDropdown`), bukan chip. State aktifnya diturunkan dari `primary.subtle` supaya tetap konsisten. Kalau mau nol invensi: pakai `<select>` bergaya `db-input` untuk semua filter, dan chip cuma untuk preset rentang tanggal.

### 3.3 Tema gelap — keputusan yang diambil sadar

Website ini **light-only** (dark mode cuma di 1 dari 61 halaman; bukan konvensi). Tapi `window.openai.theme` bisa `dark`, dan kartu putih murni di chat gelap itu menyilaukan.

Keputusan: light dulu, plus satu blok override token untuk `theme === "dark"` — permukaan `#1D1D1D` (`black` di palet), garis `#2E2E2E`, teks `#EAEAEA` (`plaster`), sekunder `#9CA3AF`, primary tetap `#007AFF`, `primary.subtle` jadi `rgba(0,122,255,.16)`. Aksen tidak berubah, jadi brand tetap terbaca sama.

### 3.4 Bahasa

Website punya tiga locale (id/en/es). Widget membaca `window.openai.locale` dan memakai satu peta string kecil per widget. Default `id`. Angka uang: `Intl.NumberFormat(locale, { style:"currency", currency })` — `currency` datang dari data (`resolvedCurrency` per booth, atau kunci grup di revenue summary), **jangan** dipatok IDR.

---

## 4. Fase 1 — infrastruktur (belum ada widget yang kelihatan)

### 4.1 `safe()` mengeluarkan `structuredContent`

`src/mcp/server.ts` sebelumnya menumpuk semua hasil jadi satu blok teks. Widget tidak bisa membacanya.

```ts
return {
  structuredContent: result,                                            // dibaca widget DAN model
  content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], // fallback Claude/Gemini
};
```

Teks fallback tidak berubah isinya, jadi klien tanpa widget tidak merasakan apa pun.

Jalur error juga ikut membawa `_meta.retryable`. `_meta` sampai ke widget tapi tidak ke model, jadi widget bisa memutuskan menampilkan tombol "Coba lagi" atau tidak, tanpa mengotori konteks model.

### 4.2 Helper registrasi widget

`src/mcp/widgets.ts`:

- `registerWidget(server, { uri, name, title, html, description, csp })` — mendaftarkan resource `text/html;profile=mcp-app`.
- `withWidget(config, uri, { invoking, invoked })` — menempelkan `_meta` pada config tool.

Yang ditempelkan ke tool:

```ts
_meta: {
  "ui.resourceUri": uri,              // standar MCP Apps
  "openai/outputTemplate": uri,       // alias kompatibilitas ChatGPT
  "openai/toolInvocation/invoking": "…",   // maks 64 char
  "openai/toolInvocation/invoked": "…",
}
```

dan ke resource: `ui.prefersBorder`, `ui.csp`, `openai/widgetDescription`.

CSP sengaja kosong. Widget **tidak** memanggil `apiUrl` langsung — semua data lewat `callTool`, jadi token tidak pernah keluar dari server. Logo dibuat inline SVG supaya tidak butuh `resourceDomains`.

### 4.3 Cara membangun HTML-nya

Repo ini belum punya bundler (cuma `tsc` + `tsx`). Untuk tiga widget berisi form dan kartu, React + bundler adalah biaya yang belum perlu.

**Keputusan:** HTML + vanilla JS sebagai template literal di `src/ui/<nama>.ts`, mengimpor `tokens.ts` bersama. Nol dependensi baru, nol build step, `tsc` tetap satu-satunya build. Kalau widget keempat butuh state kompleks, baru masukkan `esbuild` dan inline hasilnya saat build.

---

## 5. Fase 2 — widget `connect_account`

Dikerjakan pertama: paling kecil, dampak UX paling besar (sekarang cuma URL polos yang harus di-copy), dan sekaligus jadi bukti hidup bahwa 2.1/2.2 benar.

**Tool baru:** `connection_status` — read-only, tanpa argumen, mengembalikan `{ connected, status, email? }` dari `tokens`. Tidak menyentuh Studio sama sekali. Diperlukan karena widget harus polling; tanpa ini widget tidak tahu kapan operator selesai approve. Ditandai `openai/widgetAccessible` supaya boleh dipanggil dari dalam iframe.

**Anatomi kartu:**

```
┌─────────────────────────────────────────────┐
│  ◆ Dreambooth                                │  logo SVG + wordmark
│                                              │
│  Hubungkan akun Dreambooth                   │  16px/600 carbon
│  Setujui lewat Google untuk melihat data     │  13px gray-500
│  booth Anda di sini.                         │
│                                              │
│  ┌───────────────────────────────────────┐   │
│  │  Hubungkan dengan Google              │   │  db-btn, full width
│  └───────────────────────────────────────┘   │
│                                              │
│  Belum punya akun? Menyetujui otomatis       │  12px gray-500
│  membuatkannya, lengkap dengan uji coba      │
│  Pro 14 hari.                                │
└─────────────────────────────────────────────┘
```

**State machine:**

| State | Tampilan |
|---|---|
| `idle` | seperti di atas |
| `waiting` | tombol disabled + spinner, "Menunggu persetujuan di browser… (12d)", timer naik, link "Buka lagi" |
| `connected` | centang `#025E4A`, "Tersambung sebagai budi@toko.com", kartu menyusut |
| `expired` | teks `warning.ink`, "Tautan kedaluwarsa setelah 5 menit", tombol "Coba lagi" |

**Perilaku:**

- Tombol memakai `window.openai.openExternal({ href: authUrl })` — bukan `window.open`, yang diblokir sandbox iframe. Sediakan `<a target="_blank">` sebagai fallback kalau API-nya tidak ada.
- Setelah dibuka, polling `callTool("connection_status")` tiap 2 detik, berhenti di 5 menit (samakan dengan `POLL_CEILING_MS` di `src/auth/deviceFlow.ts`).
- `setWidgetState({ phase, startedAt })` supaya scroll ulang tidak me-reset timer.
- **`connect_account` tetap tidak `readOnlyHint`.** Widget tidak mengubah itu.

**Kriteria selesai:** operator asing (bukan kita) bisa dari nol sampai lihat angka omzet tanpa pernah menyalin URL.

---

## 6. Fase 3 — widget `get_revenue_summary`

Kartu ringkasan, plus chip periode yang memicu query ulang. Ini padanan terdekat dari kartu app di screenshot.

```
┌──────────────────────────────────────────────────┐
│  Ringkasan omzet            [7 hari][30 hari][●] │  chip, aktif = primary.subtle
│                                                  │
│  Rp 12.480.000                                   │  30px/700 carbon
│  Agustus 2026 · 3 booth                          │  13px gray-500
│                                                  │
│  ▁▃▅▂▇▄▆  ← bar SVG inline, batang #007AFF       │  tanpa library
│                                                  │
│  ──────────────────────────────────────────      │
│  Gateway            Rp 9.100.000           73%   │
│  Cash voucher       Rp 2.400.000           19%   │
│  Voucher diskon     Rp   980.000            8%   │
│  ──────────────────────────────────────────      │
│  Cetak tambahan     Rp 1.100.000                 │  dipisah, bukan bagian dari total
│  Efek AI            Rp   320.000                 │
└──────────────────────────────────────────────────┘
```

Catatan yang menentukan benar/salahnya angka:

- Endpoint mengelompokkan **per mata uang**. Kalau grup lebih dari satu, render tab mata uang di atas angka besar — **jangan pernah menjumlahkan lintas mata uang**. Ini bug yang sudah pernah kejadian di growth-metrics.
- Cetak tambahan dan efek AI dilaporkan terpisah oleh endpoint; jangan dilebur ke total.
- Chip periode memanggil `callTool("get_revenue_summary", { from, to, groupBy })`, bukan menghitung ulang di klien.
- Sertakan kalimat kecil di kaki kartu kalau operator menerima cash: "Uang tunai dan voucher tidak masuk ledger wallet."

**Prasyarat:** bentuk pasti `structuredContent` mengikuti `GET /api/me/revenue-summary`. `getRevenueSummary.ts` meneruskan `unknown` tanpa membentuk ulang, jadi tidak ada kontrak yang bisa dipercaya dari sisi MCP — **baca respons aslinya dulu sebelum menulis renderer.**

---

## 7. Fase 4 — widget `get_sessions` (padanan persis screenshot)

Pola form-dulu: model memanggil tool tanpa argumen lengkap, widget mengumpulkan sisanya.

```
┌──────────────────────────────────────────────────┐
│  Cari sesi foto                                  │
│  Pilih booth dan rentang tanggal.                │
│  ──────────────────────────────────────────      │
│  Booth                                           │
│  [ Semua booth                            ▾ ]    │  db-input select, diisi list_projects
│                                                  │
│  Dari                    Sampai                  │
│  [ 2026-08-01      ]     [ 2026-08-11      ]     │
│                                                  │
│  Status pembayaran                               │
│  ( Semua )( Settlement )( Pending )              │
│                                                  │
│                          [   Cari sesi   ]       │
└──────────────────────────────────────────────────┘
```

Setelah dijalankan, kartu berganti jadi hasil: "128 sesi · 20 ditampilkan", tabel ringkas (tanggal, booth, status, nominal), dan tombol "Lihat semua" yang meminta `requestDisplayMode({ mode: "fullscreen" })`.

- Dropdown booth diisi lewat `callTool("list_projects")` saat mount — **butuh 2.2 lulus**. Kalau gagal, ubah `get_sessions` supaya menyertakan daftar booth di `structuredContent`-nya.
- Simpan pilihan lewat `setWidgetState` supaya pertanyaan lanjutan tidak mengosongkan form.
- Batasi `limit` maksimal 100 seperti sekarang, dan katakan di UI kalau hasilnya terpotong. Jangan diam-diam memotong.

---

## 8. Auth dan distribusi

**Untuk dipakai sendiri / pilot (sekarang):** ChatGPT developer mode, connector diarahkan ke `https://mcp.dreamboothstudio.com/mcp`. Device flow yang ada sekarang tetap sah — widget Fase 2 justru memperbaiki UX-nya.

**Untuk terdaftar di direktori app (nanti):** OpenAI meminta OAuth 2.1 (opsional plus mTLS OpenAI-managed), endpoint HTTPS stabil yang bisa direview dan diverifikasi domainnya, serta batas latensi. Device flow in-band tidak memenuhi syarat itu. Sekalian, hardening yang sudah dicatat sebagai Fase 3 di README — scope, registry token, revocation, TTL 30 hari — memang harus mendahului listing publik.

Urutannya: widget dulu di developer mode (murah, bisa dipakai pilot), OAuth belakangan dan hanya kalau memang mau listing publik. Kecuali §2.1 gagal — kalau itu terjadi, OAuth naik jadi prasyarat.

---

## 9. Yang bukan cakupan

- Tool tulis apa pun. Widget read-only, titik.
- Migrasi ke OAuth 2.1 (kecuali dipaksa §2.1).
- Pengajuan direktori app publik.
- Widget untuk `search_docs`, `get_credits`, `get_gallery_stats`, `get_project`, `get_wallet_transactions` — teks sudah cukup untuk semuanya. Tiga widget adalah keseluruhan cakupan.
- Dukungan widget di Claude/Gemini. `_meta.ui.resourceUri` memang standar MCP Apps, jadi suatu hari mungkin jalan sendiri; sampai itu terjadi mereka memakai `content` teks dan itu memang sudah dirancang begitu.

---

## 10. Urutan kerja

| # | Pekerjaan | Bergantung pada | Status |
|---|---|---|---|
| 0 | Sweep sesi idle + `session_info` untuk uji kontinuitas | — | kode selesai, **uji ChatGPT belum** |
| 1 | `safe()` → `structuredContent`, `widgets.ts`, `tokens.ts` | 0 | selesai |
| 2 | `connection_status` + widget connect | 1 | selesai, **belum diuji di ChatGPT** |
| 3 | Widget revenue summary | 1 + baca respons endpoint | belum |
| 4 | Widget pencari sesi | 1, dan §2.2 untuk dropdown booth | belum |
| 5 | Locale id/en/es lengkap, kualitas fallback | 2–4 | sebagian (id/en/es sudah di widget connect) |

## 11. Daftar periksa verifikasi

- [ ] Claude Desktop (stdio) masih menjawab kesembilan tool dengan benar setelah `safe()` diubah — teks fallback tidak berubah isinya.
- [x] `npm run inspect` dan `inspect:http` hijau.
- [ ] Sesi dengan token kedaluwarsa: widget menampilkan pesan `StudioError`, bukan kartu kosong.
- [ ] Operator kedua di sesi lain tidak pernah melihat data operator pertama (isolasi sesi masih utuh setelah widget bisa `callTool`).
- [ ] Grup mata uang ganda dirender terpisah, tidak dijumlahkan.
- [ ] Kartu terbaca di tema gelap ChatGPT.
- [ ] `theme`, `locale`, `openExternal`, `requestDisplayMode` semuanya di-feature-detect; widget tetap berfungsi kalau salah satu tidak ada.
