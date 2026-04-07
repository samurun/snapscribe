# Snapscribe — Onboarding / Self-host Guide

Snapscribe เป็น local-first AI video editor: ตัด silence อัตโนมัติ + ถอดเสียงไทย/อังกฤษ ผ่าน Google Cloud Chirp ทุกอย่างแพ็คเป็น Docker stack เดียว — เครื่องที่จะรันต้องมีแค่ Docker

---

## 1. Prerequisites

- Docker Engine 24+ และ Docker Compose v2 (`docker compose version`)
- (Optional) Node.js 20 + pnpm — เฉพาะถ้าจะใช้คำสั่ง `pnpm apptear:*` shortcut ถ้าไม่มีก็พิมพ์ `docker compose ...` ตรงๆ ได้
- GCP service account JSON สำหรับ Chirp (ดูข้อ 3)

ไม่ต้องลง Node, Bun, Python, uv, ffmpeg บน host — ทุกอย่างอยู่ใน container

---

## 2. First-time setup

```bash
git clone <repo>
cd snapscribe
cp .env.prod.example .env
```

แก้ค่าใน `.env`:

| Var | ทำไมต้องแก้ |
|---|---|
| `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`, `RABBITMQ_PASSWORD` | เปลี่ยนทุกครั้งก่อน expose ออกเน็ต |
| `NEXT_PUBLIC_API_BASE` | URL ของ API ที่ **browser** จะเข้า เช่น `http://192.168.1.50:3001` หรือ `http://snapscribe.local:3001` ถ้ารัน local เครื่องเดียวก็ใช้ `http://localhost:3001` ได้ |
| `GCP_PROJECT`, `GCP_BUCKET` | project + GCS bucket สำหรับ Chirp batch transcription |

> ⚠️ ค่า `NEXT_PUBLIC_API_BASE` ถูก bake เข้า bundle ตอน build จะแก้ทีหลังต้อง `pnpm apptear:rebuild`

---

## 3. GCP credentials

> ⚠️ **ต้องวางไฟล์นี้ก่อน `apptear:up` ครั้งแรกเสมอ** ถ้า path `secrets/gcp-sa.json` ไม่มีไฟล์อยู่ Docker จะ auto-create เป็น **directory เปล่า** ทันทีที่ start container แล้ว worker จะพังด้วย `IsADirectoryError` ถ้าเผลอแล้ว → `docker compose down && rm -rf secrets/gcp-sa.json` แล้ววางไฟล์จริงก่อน up ใหม่

1. เปิด https://console.cloud.google.com/iam-admin/serviceaccounts (เลือก project ที่ตรงกับ `GCP_PROJECT` ใน `.env`)
2. **Create Service Account** → ตั้งชื่อ → **Grant access** → ให้ 2 roles:
   - `Cloud Speech Client` (`roles/speech.client`)
   - `Storage Object Admin` (`roles/storage.objectAdmin`)
3. คลิก SA ที่สร้าง → tab **KEYS** → **ADD KEY** → **Create new key** → **JSON** → **CREATE**
4. browser จะ download ไฟล์ `<project>-<hash>.json` มาที่ `~/Downloads/`
5. วาง:
   ```bash
   cp ~/Downloads/<project>-<hash>.json secrets/gcp-sa.json
   chmod 600 secrets/gcp-sa.json
   ```
6. ตรวจว่าเป็น key จริง ไม่ใช่ placeholder:
   ```bash
   head -3 secrets/gcp-sa.json
   ```
   ต้องเห็น `"type": "service_account"` และ `"private_key_id"` เป็น hex ยาวๆ (ไม่ใช่ `"abc"`) ถ้า `private_key_id` เป็น dummy → google-auth จะ fallback ไป metadata server ได้ error `Connection refused localhost:8080/token`

7. เปิด APIs ใน project ให้ครบ (ครั้งเดียว):
   - [Cloud Speech-to-Text API](https://console.cloud.google.com/apis/library/speech.googleapis.com)
   - [Cloud Storage API](https://console.cloud.google.com/apis/library/storage.googleapis.com)

8. สร้าง GCS bucket ที่จะใส่ใน `GCP_BUCKET` (Chirp ใช้สำหรับ batch upload):
   ```bash
   gcloud storage buckets create gs://<your-bucket> --project=<your-project> --location=us-central1
   ```

โฟลเดอร์ `secrets/` ถูก gitignore แล้ว

---

## 4. Run

```bash
pnpm apptear:up
# หรือถ้าไม่มี pnpm:
docker compose up -d --build
```

ครั้งแรกจะ build images (~3-5 นาทีบน laptop) ครั้งถัดไปจะใช้ cache

ตรวจว่าทุก service healthy:

```bash
pnpm apptear:ps
# หรือ: docker compose ps
```

ทุกแถวควรขึ้น `running` และ service หลัก (postgres / minio / rabbitmq / api) เป็น `healthy`

---

## 5. Verify

- เปิด http://localhost:3000 (หรือ host ที่ตั้งใน `NEXT_PUBLIC_API_BASE`) → เห็นหน้าหลัก
- อัปโหลด video สั้นๆ → เห็น row ใหม่ในรายการ
- กด **Transcribe** → ดู worker logs:
  ```bash
  pnpm apptear:logs   # หรือ: docker compose logs -f worker
  ```
- ถอดเสร็จจะเปิด editor ให้อัตโนมัติ

Endpoints อื่น:

| Service | URL |
|---|---|
| Web | http://localhost:3000 |
| API | http://localhost:3001 |
| MinIO console | http://localhost:9001 (snapscribe / ตามที่ตั้งใน `.env`) |
| RabbitMQ mgmt | http://localhost:15672 |

---

## 6. Common operations

```bash
pnpm apptear:up         # build + start ทั้ง stack (idempotent)
pnpm apptear:down       # stop ทั้ง stack (เก็บ data ไว้)
pnpm apptear:logs       # tail logs ทุก service
pnpm apptear:ps         # ดูสถานะ
pnpm apptear:rebuild    # build ใหม่แบบ no-cache แล้ว up — ใช้ตอนแก้ NEXT_PUBLIC_API_BASE หรืออัปเกรด deps
pnpm apptear:reset      # ⚠️ DESTRUCTIVE: stop + ลบ volumes ทั้งหมด (postgres, minio, rabbit) เริ่มใหม่หมด
```

แก้โค้ดแล้วต้องการ deploy ใหม่: `git pull && pnpm apptear:up` (Compose จะ rebuild เฉพาะ service ที่ source เปลี่ยน)

---

## 7. Troubleshooting

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| เปิด http://localhost:3000 ได้ แต่หน้าเว็บฟ้องเรียก API ไม่ได้ | `NEXT_PUBLIC_API_BASE` ไม่ตรงกับ host ที่เข้าจริง — แก้ใน `.env` แล้ว `pnpm apptear:rebuild` |
| `worker` exit code 1, log บอก "Could not automatically determine credentials" | `secrets/gcp-sa.json` หาย/permissions ผิด ตรวจ `ls -l secrets/gcp-sa.json` |
| `IsADirectoryError: '/gcp/sa.json'` | ลืมวางไฟล์ก่อน up → Docker auto-create เป็น directory แก้: `docker compose down && rm -rf secrets/gcp-sa.json && cp <real-key>.json secrets/gcp-sa.json && pnpm apptear:up` |
| `not a directory: Are you trying to mount a directory onto a file` | container เก่าจำ state directory ไว้ แก้: `docker compose down && docker compose rm -f worker && pnpm apptear:up` |
| `RetryError ... localhost:8080/token Connection refused` | `gcp-sa.json` เป็น **placeholder** ไม่ใช่ key จริง (`private_key_id: "abc"`) ต้อง download key จริงจาก GCP Console tab Keys → Add Key → JSON |
| `PermissionDenied` ตอน transcribe | service account ไม่มี role `Cloud Speech Client` หรือ `Storage Object Admin` |
| `NotFound: bucket ...` ตอน transcribe | `GCP_BUCKET` ใน `.env` ไม่มีอยู่จริงใน GCP สร้าง: `gcloud storage buckets create gs://<bucket> --project=<project>` |
| Job ค้าง `queued` ตลอด | worker ไม่ขึ้น — `docker compose logs worker` |
| Job ขึ้น `error` → `BUCKET_NOT_FOUND` | `GCP_BUCKET` ไม่มีจริง สร้าง bucket ใน GCS หรือเปลี่ยนค่า |
| `port already in use` ตอน up | host port ชน ตั้ง `API_HOST_PORT`, `WEB_HOST_PORT`, ฯลฯ ใน `.env` ให้เป็นค่าอื่น |
| ต้องการเริ่มใหม่หมด | `pnpm apptear:reset` (ลบ volumes) แล้ว `pnpm apptear:up` |

ดู log เฉพาะ service: `docker compose logs -f api` (เปลี่ยนเป็น `web` / `worker` / `postgres` ฯลฯ)

---

## 8. Architecture

```
                        ┌─────────────┐
       browser ────────▶│  web :3000  │  Next.js (prod build)
                        └──────┬──────┘
                               │ NEXT_PUBLIC_API_BASE
                        ┌──────▼──────┐
                        │  api :3001  │  Bun + Elysia + Drizzle
                        └──┬───┬───┬──┘
                           │   │   │
                  ┌────────┘   │   └────────┐
                  ▼            ▼            ▼
            ┌──────────┐ ┌──────────┐ ┌──────────┐
            │ postgres │ │  minio   │ │ rabbitmq │
            │   jobs   │ │  blobs   │ │   queue  │
            └────▲─────┘ └────▲─────┘ └────┬─────┘
                 │            │            │
                 └────────────┴────────────┘
                              │
                       ┌──────▼──────┐
                       │   worker    │  Python 3.12 + ffmpeg
                       │  (pika)     │       │
                       └─────────────┘       │
                                             ▼
                                     Google Cloud Chirp
                                     (gcp-sa.json)
```

API เป็น stateless gateway, worker เป็น consumer ที่ scale แนวนอนได้ (`docker compose up -d --scale worker=3`)
