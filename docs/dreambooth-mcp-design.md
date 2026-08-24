# `dreambooth-mcp` — desain teknis v1

Status: **terimplementasi.** Ditulis 2026-08-10 sebagai rancangan (menindaklanjuti
*Rencana Distribusi AI 2026-08-06*, Mesin A), dan disimpan di sini sebagai catatan
keputusan — bukan sebagai rencana yang masih menunggu dikerjakan.

Semua fakta route di dalamnya diaudit terhadap `dreambooth @ fix/ops-digest-name-problem-booth`,
2026-08-10. Isinya sengaja **tidak** ditulis ulang mengikuti kode: nilainya justru pada
alasan-alasan yang dicatat sebelum kodenya ada.

## Apa yang berubah sejak rancangan ini ditulis

Ditinjau ulang **2026-08-24** terhadap `dreambooth-mcp @ origin/main`. Dua bagian
sudah dilewati kenyataan sejauh menyesatkan kalau dibaca sebagai spesifikasi —
§5 (auth) dan §7 (tool) — jadi keduanya dicatat eksplisit di bawah.

| Bagian | Keadaan sekarang |
|---|---|
| §5–§8 (service, transport, auth) | Terbangun dan hidup di `https://mcp.dreamboothstudio.com/mcp`, terbit di registry sebagai `com.dreamboothstudio/dreambooth` |
| §6 (3 migrasi route + `GET /api/me/revenue-summary`) | **Selesai** — `dreambooth` PR #563 |
| §7 (8 tool, “semuanya baca”) | **Terlampaui jauh, dan asumsi read-only-nya batal.** 26 berkas tool di `src/tools/`, termasuk tool **tulis**: `create_booth`, `save_frame`, `create_filter`, `duplicate_project`, `update_booth_draft`. Ada juga alur berulir yang tidak terbayang di sini: `start_frame`/`refine_frame`/`check_generation` dan `start_booth`/`refine_booth`. `get_balance` kini bernama `get_wallet_transactions`. |
| §5 (model auth) | **Bukan lagi sekadar JWT NextAuth telanjang.** OAuth 2.1 sudah jalan: metadata protected-resource (`src/mcp/wellKnown.ts`), tantangan `WWW-Authenticate` (`src/auth/challenge.ts`), dan scope betulan di `src/auth/scopes.ts` — `booths:read` dan `booths:write`. Studio tetap authorization server dan tetap pemegang otoritas daftar scope (`lib/oauth/tokens.ts`). |
| §10 no. 1 (repo di bawah org) | Terjawab: `Dreambooth-Studio/dreambooth-mcp` |
| §10 no. 2 (subdomain) | Terjawab: `mcp.dreamboothstudio.com` |

Yang **belum** berubah dan masih berlaku apa adanya:

- **§10 no. 3 — dua lubang auth pre-existing** (`POST /api/auth/token` dan
  `POST /api/projects/token`). Keduanya masih ada di `main` per 2026-08-24. Masih
  blocker Fase 3, bukan kerja paralel.

> **§5 dan §7 dibaca sebagai sejarah, bukan sebagai keadaan sekarang.** Kalimat
> “delapan, semuanya baca” di §7 dan “tanpa scope, tanpa pencabutan” di §5 ditulis
> sebelum tool tulis dan sebelum OAuth ada. Yang masih bernilai di sana adalah
> alasan kenapa saat itu dianggap cukup — bukan angkanya.

---

## 1. Cakupan

**v1 = read-only.** Delapan tool baca, satu transport, satu jalur auth. Tidak ada tool tulis, tidak ada tool publik tanpa login — keduanya Fase 2.

**Bukan cakupan, permanen:** penarikan dana, rekening payout, MFA/step-up, regenerasi token subscription, dan seluruh `/api/admin`. Tetap khusus dashboard.

**Prinsip yang tidak boleh dilanggar:** `dreambooth-mcp` tidak memiliki query Mongo, tidak memiliki logika bisnis, dan tidak memiliki database. Ia menerjemahkan JSON-RPC ke HTTPS dan sebaliknya. Begitu sebuah agregasi disalin ke sini, ia jadi sumber kebenaran kedua yang akan menyimpang tanpa ada yang sadar.

## 2. Kenapa service terpisah

Bukan karena berat — modelnya jalan di sisi ChatGPT/Claude, kita bayar nol inference, dan tiap panggilan cuma satu hop HTTPS. Alasannya **koneksi hidup lama dan stateful**: Streamable HTTP mode stateful memegang `Mcp-Session-Id` dan bisa menahan stream terbuka, sementara Studio berjalan di Vercel serverless (tiap invocation instance berbeda, durasi dibatasi ≤300 detik). Railway memberi proses Node yang hidup terus.

Beban ke Studio ≈ nol tambahan: MCP memanggil route REST yang sama dengan yang dipanggil dashboard. KPI Fase 1 adalah ≥5 operator pilot — sekitar 100 request/hari, setara satu user dashboard tambahan.

## 3. Struktur repo

Meniru `dreambooth-whatsapp` (Railway, live, diaudit): Node ≥20, TypeScript ES2022/CommonJS strict, express + pino, `tsc` → `node dist/index.js`.

```
dreambooth-mcp/
├── railway.json
├── package.json            # node>=20; dev: tsx watch, build: tsc, start: node dist/index.js
├── tsconfig.json           # ES2022, CommonJS, strict
├── .gitignore              # WAJIB berisi .env — lihat catatan di §4
├── README.md               # cara pasang connector di ChatGPT/Claude/Gemini
└── src/
    ├── index.ts            # express, /health, pasang transport MCP, shutdown SIGTERM
    ├── config.ts           # env divalidasi saat boot; gagal cepat kalau kurang
    ├── logger.ts           # pino; satu baris per request + latensi
    ├── mcp/
    │   ├── server.ts       # McpServer + registrasi tool
    │   └── transport.ts    # Streamable HTTP, sesi, keepalive
    ├── studio/
    │   ├── client.ts       # fetch berpembatas waktu ke DREAMBOOTH_API_URL; sisip Bearer
    │   └── errors.ts       # 401/403/429/5xx → pesan MCP yang bisa dibaca model
    ├── auth/
    │   ├── deviceFlow.ts   # authorize → poll status → simpan token
    │   └── tokenStore.ts   # per sesi, DALAM MEMORI. Tidak ditulis ke disk.
    └── tools/
        ├── index.ts        # daftar; satu file per tool
        ├── listProjects.ts
        ├── getProject.ts
        ├── getSessions.ts
        ├── getRevenueSummary.ts
        ├── getBalance.ts
        ├── getCredits.ts
        ├── getGalleryStats.ts
        └── searchDocs.ts
```

Tiap file tool berisi: nama, deskripsi, skema input (zod), dan satu fungsi yang memanggil `studio/client.ts` lalu membentuk hasilnya. Tidak lebih.

## 4. Deployment

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "buildCommand": "npm run build" },
  "deploy": {
    "startCommand": "npm start",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 100,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

Key `builder` sengaja dihilangkan — Railway sudah pindah ke Railpack; `dreambooth-whatsapp` masih menulis `NIXPACKS` dan itu peninggalan.

Env: `PORT` (di-inject Railway), `LOG_LEVEL`, `DREAMBOOTH_API_URL=https://dreamboothstudio.com`. Tidak ada secret aplikasi di v1 — token milik operator, bukan milik service.

Dua hal yang **tidak** ditiru dari whatsapp:
- Repo itu sengaja meng-commit `.env` berisi kredensial live. Di sini `.env` **wajib** masuk `.gitignore`.
- Volume. MCP server stateless; whatsapp butuh volume hanya untuk state sesi Baileys.

Domain: `mcp.dreamboothstudio.com`. Project Railway sendiri, bukan digabung dengan whatsapp — ia hanya bicara ke API publik, tidak butuh private network bersama.

`/health` didaftarkan **sebelum** middleware auth, mengikuti penjaga port whatsapp (`PORT` → `API_PORT` → default, divalidasi integer).

## 5. Auth v1 — pakai ulang device flow yang sudah ada

Studio sudah punya OAuth device flow lengkap, dibuat untuk booth Electron. Nol backend baru untuk v1.

```
operator: "hubungkan akun Dreambooth saya"
   │
   ├─ MCP: POST /api/auth/desktop/google/authorize  {mode:"login"}
   │        → { state (32-byte hex), authUrl }            state TTL 5 menit
   │
   ├─ MCP balas ke model: "Buka <authUrl> untuk menyetujui."
   │        operator menyelesaikan Google sign-in di browser-nya sendiri
   │
   ├─ MCP polling: GET /api/auth/desktop/status?state=…
   │        → { status:"completed", sessionToken, user }
   │
   └─ simpan sessionToken di memori, terikat ke Mcp-Session-Id
```

Saat startup dan setiap kena 401: `POST /api/auth/desktop/check-session {sessionToken}` → `{valid}`. Sudah ada, tinggal dipanggil.

**Jujur soal kekuatannya:** `sessionToken` itu JWT NextAuth — kredensial setara sesi penuh, umur 1 tahun, tanpa scope, tanpa pencabutan, tanpa audit per-token. Cukup untuk pilot tertutup dengan akun sendiri dan 2–3 operator dekat. **Tidak cukup untuk listing connector publik** — itu pengerasan Fase 3 (klaim scope di JWT, registry token + pencabutan, TTL 30 hari).

Token disimpan **hanya di memori**, tidak pernah ke disk dan tidak pernah ke log. Restart Railway = operator menghubungkan ulang. Itu trade-off yang benar untuk v1: tidak ada penyimpanan kredensial yang harus dijaga.

Catatan MFA: token hasil login membawa `mfaVerified:false` dan route sensitif sudah menolaknya. Pertahankan, jangan diakali.

## 6. Kerja di sisi Studio — tepat 3 migrasi route + 1 endpoint baru

Ini bagian yang paling sering diremehkan, dan ternyata jauh lebih kecil dari dugaan awal.

Peta auth saat ini: **59** route menerima Bearer lewat `resolveAuthSession`, **136** route hanya menerima cookie lewat `getServerSession`, dari 334 route total. Alternatif "mode cookie-spoofing" (MCP memalsukan header session cookie) rapuh dan sebaiknya tidak pernah dirilis.

Yang dibutuhkan 8 tool v1:

| Route | Status sekarang | Tindakan |
|---|---|---|
| `/api/sessions` | Bearer OK | — |
| `/api/gallery` | Bearer OK | — |
| `/api/device-monitoring` | Bearer OK | — |
| `/api/docs-index` | publik | — |
| `/api/projects` | **cookie only** | tambah `resolveAuthSession` |
| `/api/credits` | **cookie only** | tambah `resolveAuthSession` |
| `/api/wallet-transactions` | **cookie only** | tambah `resolveAuthSession` |
| revenue per-operator | **tidak ada** | endpoint baru — lihat bawah |

**Jadi v1 butuh tiga route disentuh, bukan 136.** Perubahannya beberapa baris per route (ganti `getServerSession(auth)` dengan `resolveAuthSession(request)`), dan setelah itu cookie-spoofing tidak pernah perlu ditulis sama sekali.

### Endpoint baru: `GET /api/me/revenue-summary`

`/api/analytics/revenue` **superadmin-only** — ada `isSuperAdmin` gate di dalamnya, jadi operator biasa kena 403. Tidak ada route revenue ter-scope pemilik di Studio.

Satu-satunya logika revenue per-operator yang benar ada di `lib/ai-chat/revenueBreakdown.ts` (tool chat `getMyRevenueBreakdown`) — yang mencerminkan `$cond` analytics, memisahkan channel gateway/cash-voucher/discount-voucher, dan hanya menghitung yang settled.

Endpoint baru ini **membungkus fungsi itu**, tidak menyalinnya. Alasannya lugas: kalau agregasinya disalin ke `dreambooth-mcp`, itu jadi perhitungan revenue **keempat** setelah analytics, `revenueBreakdown.ts`, dan chat — dan tiga angka omzet yang berbeda akan muncul tanpa ada yang tahu mana yang benar. Berlaku sama untuk `earningsBreakdown.ts` kalau nanti diekspos.

## 7. Tool v1

Delapan, semuanya baca, semuanya ter-scope ke pemilik token.

| Tool | Membungkus | Input |
|---|---|---|
| `list_projects` | `GET /api/projects` | — |
| `get_project` | `GET /api/projects` + `GET /api/device-monitoring` | `projectId` |
| `get_sessions` | `GET /api/sessions` | rentang tanggal, status, sumber pembayaran, promo |
| `get_revenue_summary` | `GET /api/me/revenue-summary` *(baru)* | rentang tanggal, `projectId?` |
| `get_balance` | `GET /api/wallet-transactions` | rentang tanggal opsional |
| `get_credits` | `GET /api/credits` | — |
| `get_gallery_stats` | `GET /api/gallery` | `projectId?` |
| `search_docs` | `GET /api/docs-index` | `query`, `locale` |

`search_docs` memakai route publik, jadi ia satu-satunya yang berfungsi sebelum operator menghubungkan akun — berguna sebagai jalur "coba dulu".

**Deskripsi tool adalah antarmuka sesungguhnya.** Model memilih tool dari deskripsinya, jadi tiap deskripsi harus menyebut *kapan dipanggil*, bukan cuma apa yang dikembalikan. Angkat kata-katanya dari `lib/ai-chat/user-tools.ts` yang sudah disetel di produksi — jangan tulis ulang dari nol.

Aturan identitas diwarisi apa adanya dari Studio: model tidak pernah menerima atau memengaruhi identitas. Tidak ada tool yang menerima `userId`/`email` sebagai argumen; semuanya diresolusi server-side dari token. Kalau sebuah tool butuh argumen begitu, desainnya salah.

## 8. Transport

Streamable HTTP. Tool v1 semuanya request-response, jadi mayoritas panggilan dijawab dengan **JSON biasa** tanpa membuka stream sama sekali — SSE hanya diperlukan saat server mendorong (notifikasi progress, request balik ke klien).

Yang tetap harus diuji karena tidak ada hubungannya dengan pilihan bahasa:

- **Proxy edge Railway memutus koneksi idle.** Butuh keepalive ping berkala + reconnect di sisi klien.
- **Default timeout Node** (`server.requestTimeout`, `server.headersTimeout`) memutus request panjang — naikkan/nolkan eksplisit untuk endpoint stream.
- **Buffering proxy** bisa menahan event. Uji langsung, jangan diasumsikan.

## 9. Fase & verifikasi

| Fase | Isi | Selesai kalau |
|---|---|---|
| 0 (~1 hari) | server stdio lokal, SDK TS, 3 tool baca pakai token pribadi | Claude Desktop menjawab "booth saya minggu ini gimana" dari data asli |
| 1a | 3 migrasi route + `GET /api/me/revenue-summary` di Studio | curl dengan Bearer berhasil di keempatnya |
| 1b | 8 tool + Streamable HTTP + device flow, deploy Railway | ≥5 operator pilot terhubung |

Uji yang tidak boleh dilewat sebelum operator kedua dihubungkan:

**Isolasi identitas.** Hubungkan dua akun berbeda, panggil `get_revenue_summary` di masing-masing. Angkanya harus berbeda dan hanya berisi project miliknya. Lalu kirim `{ "userId": "<email orang lain>" }` di input tool — harus **diabaikan sepenuhnya**. Kalau argumen itu berpengaruh, ada tool yang bocor dan rilis berhenti di situ.

**Token kedaluwarsa.** Cabut/rusak token, panggil tool → harus 401 yang rapi dengan ajakan menghubungkan ulang, bukan 500.

**Route yang belum dimigrasi.** Panggil tool yang menyentuh route cookie-only dengan Bearer → harus gagal jelas, bukan diam-diam mengembalikan data kosong yang dibaca model sebagai "omzet kamu nol".

## 10. Pertanyaan terbuka

1. **Repo di bawah org.** Railway men-deploy whatsapp dari `Dreambooth-Studio/dreambooth-whatsapp` sementara clone lokalnya `chrstnale/`. Buat `dreambooth-mcp` di bawah org lalu tambahkan `chrstnale` sebagai member, mengikuti pola yang sama. *(Keputusan Ale.)*
2. **Subdomain `mcp.dreamboothstudio.com`.** *(Keputusan Ale.)*
3. **Dua lubang auth pre-existing** yang di dokumen strategi sudah dicatat: `POST /api/auth/token` memasang string apa pun dari pemanggil sebagai session cookie tanpa validasi, dan `POST /api/projects/token` memberi sesi beridentitas owner ke siapa pun yang tahu id project publik. Keduanya ada sebelum rencana ini — tapi listing connector publik mengubahnya dari hutang internal jadi permukaan serang yang diiklankan. **Sarannya: jadikan blocker Fase 3, bukan kerja paralel.**
4. **Inventaris tool di dokumen strategi kurang dua.** Halaman 3 mendaftar 6 tool baca; `lib/ai-chat/user-tools.ts` hari ini punya 8 — `getMyEarningsBreakdown` dan `getMyRevenueBreakdown` (commit `d01d9f2f`) tidak masuk daftar, kemungkinan masih PR terbuka saat audit 2026-08-06.
