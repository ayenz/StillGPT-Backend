# Panduan Integrasi Frontend — StillGPT

Untuk: tim frontend (PWA sekarang, Flutter nanti).
Versi backend: 0.1 · November 2026 · Referensi API lengkap ada di lampiran (Bagian B).

---

## 1. Gambaran singkat

StillGPT adalah backend "personal LLM" kita. Aplikasi frontend cukup bicara dengan **satu** server:

| Fitur di aplikasi | Endpoint utama |
|---|---|
| Login, profil, kuota kredit | `/auth/*`, `/me`, `/usage` |
| Chat (teks) dengan jawaban mengalir (streaming) | `/conversations`, `/conversations/:id/messages` (SSE) |
| Kirim foto / dokumen (PDF, DOCX, XLSX, CSV, …) ke chat | `/files` lalu sebut `file_id` di pesan |
| Tombol **✨ Enhance** prompt gambar/video | `/prompts/enhance` |
| Generate gambar | `/images` |
| Generate video | `/videos` + `/jobs/:id` |
| Daftar model / pilihan model | `/models` |

- **Base URL produksi:** `https://qrouter.ayenz.my.id/api/v1`
- **Base URL lokal:** `http://localhost:8790/api/v1`
- Semua JSON memakai **snake_case**. Waktu dalam ISO-8601 UTC.
- Setiap respons punya header `X-Request-Id` — sertakan saat melapor bug.

> Backend menyimpan konteks percakapan sendiri. Frontend **hanya mengirim pesan baru**, tidak pernah mengirim ulang riwayat.

---

## 2. Login dan token

Tidak ada pendaftaran publik: akun dibuat oleh admin (`POST /admin/users`). Aplikasi hanya perlu layar login.

```
POST /auth/login     {email, password}          → {user, access_token, expires_in: 900, refresh_token}
POST /auth/refresh   {refresh_token}            → {access_token, expires_in, refresh_token}   (refresh token BERGANTI)
POST /auth/logout    {refresh_token}            → 204
```

Aturan wajib:
1. Simpan **access token di memori saja**. Simpan refresh token di IndexedDB/`localStorage` (PWA) atau `flutter_secure_storage` (Flutter).
2. Saat aplikasi dibuka → panggil `/auth/refresh`.
3. Jika request apa pun mendapat `401` → refresh **sekali**, ulangi request. Jika refresh juga gagal → ke layar login.
4. **Hanya boleh satu proses refresh berjalan** (pakai satu promise bersama). Refresh token berganti setiap kali dipakai,
   jadi dua refresh paralel akan saling membatalkan.

```ts
let refreshing: Promise<string> | null = null;
async function getFreshToken(): Promise<string> {
  refreshing ??= fetch(`${API}/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: await store.getRefresh() }),
  }).then(async (r) => {
    if (!r.ok) throw new Error('logged_out');
    const t = await r.json();
    await store.setRefresh(t.refresh_token);   // simpan yang BARU
    memory.accessToken = t.access_token;
    return t.access_token;
  }).finally(() => (refreshing = null));
  return refreshing;
}
```

---

## 3. Chat dengan streaming

### 3.1 Alur
1. Buat percakapan: `POST /conversations {model?: "default", profile?: "assistant"}` → `conv_…`
2. Kirim pesan dengan streaming:
   `POST /conversations/:id/messages` + header `Accept: text/event-stream`, body `{text, attachments?: [file_id]}`
3. Baca event SSE sampai `turn.completed`.

`EventSource` bawaan browser **tidak bisa** POST dan tidak bisa mengirim header `Authorization` — pakai `fetch`
dan baca `response.body` (mis. paket `eventsource-parser` atau `@microsoft/fetch-event-source`).

### 3.2 Event yang perlu ditangani

| Event | Yang dilakukan UI |
|---|---|
| `turn.started` | buat gelembung jawaban kosong; simpan `message_id` |
| `thinking` | tampilkan indikator "sedang berpikir…" |
| `text.delta` | **tambahkan** `text` ke gelembung (render Markdown) |
| `tool.started` / `tool.completed` | opsional: chip status, mis. "🔎 Mencari di web…", "🖼️ Membuat gambar…" |
| `artifact` | tampilkan gambar/video/file (`artifact.url` bisa langsung dipakai di `<img>`/`<video>`) |
| `model.fallback` | opsional: info kecil "model X tidak tersedia, memakai Y" |
| `error` | tampilkan pesan error di gelembung (event `turn.completed` tetap menyusul) |
| `conversation.title` | judul otomatis chat baru (kayak ChatGPT): update judul di sidebar/header, idealnya pakai animasi ketik singkat |
| `turn.completed` | final: ganti isi gelembung dengan `text` lengkap, aktifkan lagi tombol kirim |

```ts
import { createParser } from 'eventsource-parser';

async function sendMessage(convId: string, text: string, attachments: string[], ui: ChatUI) {
  const res = await authFetch(`${API}/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text, attachments }),
  });
  if (res.status === 409) return ui.toast('Masih menjawab pesan sebelumnya');
  const parser = createParser({
    onEvent(ev) {
      ui.lastEventId = ev.id;                       // untuk reconnect
      const data = JSON.parse(ev.data);
      switch (ev.event) {
        case 'turn.started': ui.startAssistant(data.message_id); break;
        case 'thinking': ui.setThinking(true); break;
        case 'text.delta': ui.appendText(data.text); break;
        case 'artifact': ui.addArtifact(data.artifact); break;
        case 'conversation.title': sidebar.rename(data.conversation_id, data.title); break;
        case 'error': ui.showError(data.message); break;
        case 'turn.completed': ui.finish(data.text, data.artifacts, data.stop_reason); break;
      }
    },
  });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.feed(value);
  }
}
```

### 3.3 Putus koneksi & buka ulang aplikasi
- **Menutup tab / sinyal hilang tidak membatalkan jawaban.** Jawaban tetap dibuat dan disimpan di server.
- Saat koneksi putus: `GET /conversations/:id/stream` dengan header `Last-Event-ID: <id terakhir>` (backoff 1 s → 2 s → 5 s).
  - `200` → lanjutkan menambah event.
  - `204` → jawaban sudah selesai: muat ulang `GET /conversations/:id/messages`.
- Saat aplikasi dibuka ulang: `GET …/messages` mengembalikan `running_turn` ≠ `null` jika masih berjalan → sambung ke `/stream` tanpa `Last-Event-ID` (riwayat event diputar ulang dari awal).

### 3.4 Lain-lain
- Tombol **Stop**: `POST /conversations/:id/interrupt`.
- Satu percakapan hanya bisa memproses satu pesan sekaligus → `409 conversation_busy`. Nonaktifkan tombol kirim selama streaming.
- Daftar percakapan: `GET /conversations?limit=20&before=<next_cursor>` (terbaru dulu). Judul terisi otomatis dari pesan pertama.
- Ganti model atau system prompt di tengah percakapan: `PATCH /conversations/:id` — konteks tetap tersimpan.

---

## 4. Foto & dokumen

1. Upload dulu: `POST /files` (multipart, field `file`, maks 20 MB) → `{id, filename, mime_type, size, url}`
2. Sebut di pesan: `{text: "Ringkas dokumen ini", attachments: ["file_…"]}`

| Jenis | Perilaku | Batas |
|---|---|---|
| Foto (png, jpg, webp, gif) | dilihat langsung oleh model | 20 MB upload; > 7 MB dikirim sebagai file |
| Dokumen (pdf, docx, xlsx, csv, txt, md, …) | dibaca agent di sandbox | **5 MB** per dokumen (`413 attachment_too_large` saat kirim) |

Tampilkan preview lampiran memakai `thumbnail_url ?? url` dari respons upload (lihat §6.1). Analisa dokumen butuh 8–20 detik — tampilkan indikator dari event `tool.started`.

---

## 5. Gambar, video, dan tombol ✨ Enhance

### 5.1 Tombol ✨ Enhance (perbaiki prompt)
Di form generate gambar/video, letakkan tombol **✨ Enhance** di samping text area.

```
POST /prompts/enhance  {prompt, kind: "image" | "video", purpose?: "poster", style?, model?}
→ {prompt, original, aspect_ratio, size?, ratio?, seconds?, enhanced, model, credits}
```

Perilaku UI yang diminta:
1. Klik → tombol loading (2–10 detik).
2. **Ganti isi text area** dengan `prompt` dari respons.
3. Pilih otomatis ukuran: gambar → `size`; video → `ratio` dan `seconds` (user tetap boleh mengubah).
4. Simpan `original` agar ada tombol **↩ Kembalikan**.
5. Jika `enhanced: false`, prompt tidak berubah — tampilkan info "prompt sudah dipakai apa adanya".

Prompt boleh bahasa Indonesia; hasil enhance selalu bahasa Inggris. Untuk konten promosi (mis. baju ukuran besar),
isi `purpose` (`"poster"`, `"fashion catalog"`) — enhancer akan memakai istilah industri fashion sehingga generator
gambar lebih jarang menolak. Field `model` opsional: biarkan kosong untuk default server (saat ini Qwen4-Max-Preview, ~5–8 detik).

### 5.2 Generate gambar
```
POST /images {prompt, size?: "1024x1024", provider?: "auto" | "qoder" | "folax", input_file_ids?: [..], enhance?: false}
→ 200 job {id, status: "completed" | "failed", outputs: [{url, mime_type, …}], error}
```
- Menunggu sampai selesai (Folax ~10 detik, Qoder ~20–30 detik). Untuk tidak menunggu: `async: true` → `202`, lalu ikuti job (5.4).
- `provider: "auto"` (default): pakai **Folax** (cepat, 2 gambar per permintaan); jika gagal otomatis pindah ke **Qoder**.
- **Edit/gabung foto** (`input_file_ids`, maks 3) memakai Qoder secara default.
- **Edit Folax (opsional):**
  - Kirim `provider: "folax"` + tepat **1** `input_file_ids` + `prompt` → satu hasil dalam ~10–25 detik.
    Satu edit memotong **kuota edit mingguan bersama** (lihat 5.3a).
  - `n` harus 1.
  - Kalau gagal, job berstatus `failed` dengan `error.code`, misalnya `folax_quota_exceeded` atau `content_rejected`.
    Tidak ada fallback ke Qoder.
- **Hapus orang (Folax):**
  ```
  POST /images/:fileId/remove-people {async?: false}
  → 200 job (atau 202 kalau async)
  ```
  Selesai ~5 detik, tanpa prompt, **tidak** memotong kuota. Tombolnya cocok ditaruh di detail gambar galeri.
  Sembunyikan tombol kalau `GET /folax/status` → `available: false`.
- Ukuran Qoder: `1024x1024, 1536x1024, 1024x1536, 768x1024, 1024x768, 1024x1280, 1280x1024, 1024x1792, 1792x1024, 2560x1080`.
  Folax hanya 1:1, 4:3, 3:4, 16:9, 9:16 (ukuran lain dibulatkan ke rasio terdekat).
- Status `failed` tetap HTTP 200 — selalu cek `status` dan `error.message`.
- **Beberapa gambar sekaligus:** kirim `n` (1–10), lihat 5.5.
- Gangguan sementara di Qoder (antrean penuh, atau instance generator sedang restart / HTTP 423 *draining*) dicoba ulang otomatis oleh server;
  job tetap `in_progress` selama itu. Kalau tetap gagal, `error.code` = `upstream_queue_full` atau `upstream_draining`.

### 5.3 Generate video
```
POST /videos {prompt, seconds?: 5, resolution?: "1080P", ratio?: "16:9", audio?: true,
              first_frame_file_id?, last_frame_file_id?, reference_file_ids?: [..], enhance?}
→ 202 job {id: "vid_…", status: "queued"}
```
- Mode otomatis: teks saja → *text-to-video*; ada `first_frame_file_id` → animasikan foto (bisa + `last_frame_file_id`); ada `reference_file_ids` (1–10) → karakter/produk konsisten.
- Durasi 2–30 detik, resolusi 480P/720P/1080P, rasio 21:9, 16:9, 4:3, 1:1, 3:4, 9:16.
- **Lama: biasanya 3–8 menit, bisa sampai 30 menit.** Tidak bisa dibatalkan. Server memproses satu video sekaligus;
  jika antrean Qoder penuh, server otomatis mencoba lagi (job tetap `in_progress`).

### 5.3a Status Folax & kuota bersama
Folax adalah provider tambahan (nice-to-have). Default tetap Qoder. Fitur khusus Folax (model chat Folax, video Folax,
edit Folax, hapus orang) menyusul bertahap; kalau Folax mati, fitur itu gagal dan **tidak** pindah ke Qoder.
```
GET /folax/status
→ {configured, available, status: "ok" | "degraded" | "down", checked_at, error, usage: {video: {...}, edit: {...}} | null}
```
- **Status:**
  - `available: false` → sembunyikan atau nonaktifkan pilihan Folax. Contoh pesan: "Folax sedang tidak tersedia".
  - `degraded` → Folax tetap bisa dipakai, tapi mungkin lambat.
- **Kuota dipakai bersama semua user:** 20 video dan 20 edit per minggu. Hapus orang tidak memotong kuota.
  - Reset **Senin 07:00 WIB** (`reset_at`).
  - Tampilkan `usage.video.remaining` / `usage.edit.remaining` sebagai perkiraan, misalnya "± 12 video tersisa minggu ini".
  - `remaining: null` (`source: "unknown"`) → "sisa kuota belum diketahui".
  - Kalau `remaining` 0, nonaktifkan tombolnya.
- Hasil dicache server ±60 detik, jadi aman dipanggil saat membuka dialog.

### 5.4 Mengikuti job (gambar async & video)
- `GET /jobs/:id/events` (SSE): event `progress {status, progress}`, lalu `completed` / `failed` berisi job lengkap.
- Atau polling `GET /jobs/:id` tiap 5–10 detik.
- `progress` (0–100) adalah **perkiraan waktu**, bukan progres asli; tertahan di ≤ 95 sampai selesai.
- Riwayat: `GET /jobs?kind=video&limit=20`.

UI yang disarankan: kartu job di galeri (gambar tile dari `outputs[].thumbnail_url`, lihat §6.1) dengan progress bar, notifikasi saat `completed`, dan job tetap bisa dilihat
setelah aplikasi ditutup (ambil ulang dari `/jobs`).

### 5.5 Generate beberapa gambar sekaligus (`n`)
```
POST /images {prompt, n: 1..10, size?, enhance?, input_file_ids?, async: true}
→ 202 batch {id: "batch_…", status, progress, n, completed, failed, credits, jobs: [job, …]}
```
- Kalau `n` dikirim, respons berupa **batch** (bukan job). Tanpa `n`, respons tetap satu job seperti 5.2.
- Semua job jalan **paralel**: batch selesai kira-kira secepat satu job (Qoder ~30–40 detik, Folax ~10–15 detik).
- Tiap job ikut routing provider biasa. Di `auto`, text-to-image (tanpa `input_file_ids`) jalan di **Folax** (gratis).
- **Satu job Qoder = 1 gambar, satu job Folax = 2 gambar.** Batch Folax `n: 4` = 8 gambar. Hitung gambar dari
  `jobs[].outputs`, jangan dari `n`.
- Enhance hanya sekali untuk seluruh batch; semua gambar memakai prompt yang sama.
- Tiap gambar adalah job biasa (`jobs[i]`), urut sesuai `request.batch_index`. Satu gambar gagal tidak menggagalkan yang lain.
- `status` batch: `queued` → `in_progress` → `completed` (semua sukses) / `partial` (sebagian gagal) / `failed` (semua gagal).

Mengikuti batch:
- `GET /images/batches/:id/events` (SSE): `batch` (snapshot) → `progress {id, status, progress, batch_progress}` →
  `job.completed` / `job.failed` per gambar → `batch.done` (batch final), lalu stream ditutup.
- Atau polling `GET /images/batches/:id` tiap 5 detik. Daftar job satu batch: `GET /jobs?batch_id=…`.
- Jika SSE putus: `GET /images/batches/:id`, lalu sambung ulang bila masih `queued`/`in_progress`.
- Jumlah maksimum `n` dibaca dari `GET /models` → `image_providers[].max_n` provider yang dipakai (jangan hardcode 10); gambar per job = `images_per_call`.

### 5.6 Hapus dari galeri + Urungkan
```
DELETE /jobs/:id                      → 204          (409 job_running jika masih diproses)
POST   /jobs/delete {ids: [..maks 100]} → {trashed: [..], skipped: [{id, reason}]}
DELETE /images/batches/:id            → {trashed, skipped}
POST   /jobs/clear-failed             → {trashed, skipped}   (tombol "Bersihkan yang gagal")
POST   /jobs/:id/restore              → job          (tombol Urungkan)
```
- Hapus = masuk **sampah**: langsung hilang dari `GET /jobs`, dan URL gambar/videonya langsung 404. File baru dihapus
  permanen setelah masa tenggang (default 7 hari, diatur admin).
- User **tidak** bisa melihat sampah. Setelah menghapus, tampilkan toast "Dihapus · **Urungkan**" (±5–10 detik) yang
  memanggil `POST /jobs/:id/restore` untuk tiap id yang dihapus. Lewat dari itu, pemulihan hanya lewat admin.
- Job yang masih `queued`/`in_progress` tidak bisa dihapus: nonaktifkan tombol hapus sampai selesai.
- Hapus banyak: mode pilih di galeri → `POST /jobs/delete`. Tampilkan jumlah `skipped` bila ada.
- Setelah menghapus, buang item dari state lokal; jangan simpan URL lama (akan 404).

### 5.7 Halaman admin: Sampah & housekeeping media (khusus admin)
- **Sampah:** `GET /admin/trash?kind=&user_id=&limit=50` → grid dengan pemilik (`user.email`), `deleted_at`, `purge_at`
  ("dihapus permanen mulai …"), ukuran. Thumbnail pakai `job.outputs[].thumbnail_url` dari respons ini (URL khusus admin).
  Aksi: **Pulihkan** (`POST /admin/trash/restore {ids}`) dan **Hapus permanen** (`POST /admin/trash/purge {ids}`, minta konfirmasi).
  Paging: kirim `before = next_before` sampai `null`.
- **Pengaturan:** `GET /admin/media-housekeeping` → form untuk `trash_grace_days` (masa tenggang), `hide_failed_after_days`,
  `archived_chat_media_days`, `unused_upload_days`, `retention_days` (0 = mati), `interval_hours`, `enabled`;
  simpan dengan `PATCH` (kirim field yang diubah saja). Tampilkan juga `storage` (total & isi sampah), `last_run.report`
  dan `next_run_at`. Tombol **Simulasi** (`POST /admin/media-housekeeping/run {dry_run: true}`) dan **Jalankan sekarang**.

---

## 6. File & URL media

- Semua `url` gambar/video/file adalah **URL bertanda tangan** (`/media/file_…?exp=…&sig=…`): bisa langsung dipakai di `<img>`, `<video>`, atau link unduh **tanpa** header Authorization.
- URL kedaluwarsa (minimal 7 hari) → ambil ulang dari `GET …/messages` atau `GET /jobs/:id` bila perlu. Jangan simpan URL permanen.
- URL file yang sama **tidak berubah selama sehari**, dan server mengirim `Cache-Control: immutable` + `ETag`, jadi cache browser bekerja. Jangan tambahkan `?t=Date.now()` atau cache-buster lain.
- Mendukung HTTP Range, jadi `<video>` bisa di-seek (penting untuk Safari/iOS).
- Tambahkan `&download=1` agar browser mengunduh, bukan menampilkan.

### 6.1 Thumbnail & preview (wajib dipakai di galeri)

Setiap objek yang punya `url` media (output job, artifact, lampiran, `POST /files`) juga punya:

| Field | Isi | Pakai untuk |
|---|---|---|
| `thumbnail_url` | WebP maks 400×400 px (± 20–60 KB) | tile grid galeri, gambar di bubble chat |
| `preview_url` | WebP maks 1280×1280 px | lightbox / halaman detail |
| `url` | file asli (PNG beberapa MB / MP4 utuh) | tombol unduh, putar video, zoom penuh |

- Untuk **video**, `thumbnail_url` dan `preview_url` adalah **gambar diam (poster)**, bukan video.
- Bisa `null` (dokumen, audio, SVG). Fallback: `thumbnail_url ?? url`.
- Kalau thumbnail video gagal dimuat (`404`), tampilkan ikon/placeholder video lewat `onError`.

Contoh tile galeri:
```html
<!-- gambar -->
<img src="{thumbnail_url ?? url}" loading="lazy" decoding="async" width="400" height="400" style="object-fit:cover">

<!-- video: jangan render <video> di grid -->
<img src="{thumbnail_url}" loading="lazy" decoding="async"> <span class="badge">▶</span>

<!-- saat dibuka (lightbox) -->
<img src="{preview_url ?? url}">                                   <!-- gambar -->
<video src="{url}" poster="{preview_url}" preload="none" controls>  <!-- video -->
```

---

## 7. Error

Format: `{"error": {"code": "...", "message": "..."}}`. Kode yang perlu ditangani UI:

| HTTP | code | Tindakan UI |
|---|---|---|
| 401 | `unauthorized` | refresh token sekali, lalu ke login |
| 403 | `account_disabled`, `forbidden` | tampilkan pesan, logout |
| 409 | `conversation_busy` | "Masih menjawab…", jangan kirim ulang |
| 413 | `file_too_large`, `attachment_too_large` | tampilkan batas ukuran |
| 429 | `credit_limit_exceeded` | "Kuota bulan ini habis" |
| 429 | `folax_quota_exceeded` | "Kuota Folax minggu ini habis, reset Senin 07:00 WIB" (jangan diulang) |
| 429 | `provider_busy` | "Folax sedang sibuk, coba lagi sebentar" (tunggu `details.retry_after` detik) |
| 503 | `provider_unavailable` | "Folax sedang tidak tersedia" |
| 400 | `validation_error` | tampilkan `message` dekat field terkait |
| 502/503 | `upstream_*` | "Layanan AI sedang bermasalah, coba lagi" + tombol ulangi |

Error di tengah streaming datang sebagai event `error` (lalu tetap `turn.completed` dengan `stop_reason: "error"`).

---

## 8. Catatan PWA

- **Service worker:** jangan cache respons API, terutama SSE (`/messages`, `/stream`, `/jobs/*/events`) dan `/media/*` yang bertanda tangan. Cukup cache aset statis aplikasi.
- **Proxy & timeout:** jawaban panjang bisa > 1 menit; server mengirim heartbeat `: ping` tiap 15 detik — abaikan.
- **iOS Safari:** gunakan `fetch` streaming (didukung sejak iOS 15). `<video playsinline controls>` untuk hasil video.
- **Notifikasi selesai video:** saat tab tertutup, tetap tampilkan dari `/jobs` ketika aplikasi dibuka lagi.
- **CORS:** server sudah mengizinkan origin aplikasi (minta ditambah ke `CORS_ORIGINS` bila domain berubah).

## 9. Catatan Flutter (nanti)

- Token: `flutter_secure_storage`. HTTP: `dio` atau `http`.
- SSE: kirim request dengan `Accept: text/event-stream`, baca `response.stream` lewat `utf8.decoder` + `LineSplitter`,
  pisahkan frame di baris kosong; field `id:`, `event:`, `data:` sama persis seperti di web.
- Video: `video_player` mendukung URL bertanda tangan + Range.

## 10. Kontak & lingkungan

- Akun uji: minta ke admin (dibuat via `/admin/users`). Jangan memakai akun admin untuk pengujian UI.
- API key (`qr_…`) hanya untuk server/n8n — **jangan** ditanam di aplikasi frontend.
- Spesifikasi lengkap setiap endpoint: Bagian B (API reference) di dokumen ini.
