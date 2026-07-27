# Spage — سامانه مدیریت لندینگ‌پیج توزیع‌شده

NestJS + PostgreSQL + RabbitMQ (+ Nginx در compose محلی) با دو نقش:

| نقش کاربر | `NODE_ROLE` | کار اصلی |
|-----------|-------------|----------|
| **Master** | `MASTER` | پنل ادمین، CRUD فرم، آپلود/confirm ZIP، Outbox → Edge، مصرف سابمیشن‌های Edge |
| **Edge** | `EDGE` (یا `SLAVE` برای سازگاری موقت) | سرو لندینگ، ثبت فرم محلی، مصرف `landing.sync`/`form.sync`، Outbox سابمیشن → Master |

---

## نصب سریع (پروداکشن)

> قبل از هر چیز `SPAGE_GITHUB_REPO` را روی ریپوی واقعی خودتان ست کنید (یا موقع نصب جواب دهید).

### Master

```bash
bash <(curl -Ls https://raw.githubusercontent.com/YOUR_GITHUB_USER/spage/master/install.sh)
# یا با تگ/برنچ مشخص:
bash <(curl -Ls https://raw.githubusercontent.com/YOUR_GITHUB_USER/spage/master/install.sh) master
```

اسکریپت با **پاسخ پیش‌فرض** این‌ها را می‌پرسد: مسیر نصب، پورت HTTP، توکن ادمین، پسورد Postgres/RabbitMQ، `PUBLIC_BASE_URL`، `MASTER_INTERNAL_URL`، `RABBITMQ_PUBLIC_URL`.

بعد از نصب:

- پنل: `http://SERVER/admin`
- توکن ادمین در خروجی اسکریپت چاپ می‌شود

### Edge (نود)

1. در پنل: **مدیریت نودها → افزودن نود** (عنوان، IP/hostname، پورت، …)
2. کامند نصب را کپی کنید — **هیچ سوالی نمی‌پرسد**:

```bash
bash <(curl -Ls https://raw.githubusercontent.com/YOUR_GITHUB_USER/spage/master/install-node.sh) \
  https://MASTER_URL/api/nodes/bootstrap/TOKEN
```

3. بعد از نصب، در پنل روی **Verify** بزنید تا وضعیت نود `ONLINE` شود.

هر نود صف اختصاصی `landing.sync.<id>` دارد؛ Master رویدادها را به **همه** نودهای ثبت‌شده می‌فرستد.

---

## ۱. نمای کلی توپولوژی

```
┌──────────────── Master (سرور مرکزی) ────────────────┐
│  Admin + API  │  Outbox → Edge  │  ZIP packages      │
│  PostgreSQL   │  RabbitMQ       │  consumer سابمیشن  │
│  Nodes panel  │  per-node queues│  Verify health     │
└───────┬───────────────────┬─────────────────────────┘
        │ landing.sync / form.sync    │ form.submission
        ▼                             ▲
   queue landing.sync.<node>   queue form.submission
        │                             │
        ▼                             │
┌──────────────── Edge (سرور جدا / CDN) ──────────────┐
│  consumer لندینگ+فرم │ submit محلی │ Outbox سابمیشن │
│  PostgreSQL Edge (Form, FormSubmission, Landing…)   │
└─────────────────────────────────────────────────────┘
```

- لندینگ و **ثبت فرم** روی Edge انجام می‌شود.
- تعریف فرم با `form.sync` از Master به Edge می‌آید؛ سابمیشن با `form.submission.sync` به Master برمی‌گردد.
- Edge باید مستقیماً به RabbitMQِ Master وصل شود (`RABBITMQ_PUBLIC_URL`).

---

## ۲. محلی / توسعه (کوتاه)

```bash
cp .env.example .env
docker compose up --build -d
# بعد از healthy:
bash scripts/smoke-test.sh
```

| سرویس | آدرس |
|--------|------|
| پنل ادمین | http://localhost/admin (`ADMIN_TOKEN` پیش‌فرض: `change-me-admin-token`) |
| لندینگ‌ها | http://localhost/:slug/ |
| ثبت فرم | http://localhost/api/forms/:key/submit → **Edge** |
| API مدیریتی | http://localhost/api/... → Master |
| RabbitMQ UI | http://localhost:15672 (spage/spage) |

Composeهای پروداکشن:

| فایل | کاربرد |
|------|--------|
| `docker-compose.master.yml` | Master + Postgres + RabbitMQ |
| `docker-compose.node.yml` | Edge + Postgres محلی (RMQ ریموت) |

توسعه بدون کل stack:

```bash
cp .env.example .env
npx prisma migrate deploy
npm run start:dev   # NODE_ROLE=MASTER
```

---

## ۳. پروداکشن: Edge روی سرور جدا

### پیش‌نیاز شبکه

از سرور Edge باید برسند به:

1. **RabbitMQ Master** — پورت `5672`
2. **HTTP دانلود پکیج Master** — `MASTER_INTERNAL_URL`
3. **Bootstrap API** — فقط موقع نصب: `GET /api/nodes/bootstrap/:token`

| پورت | کاربرد | توصیه فایروال |
|------|--------|----------------|
| `80`/`3000` | API + ادمین + bootstrap | ادمین را محدود کنید |
| `5672` | AMQP برای Edge | فقط IPهای Edge / VPN |
| `15672` | Management UI | فقط اپراتور |

بهترین راه: **افزودن نود در پنل** و اجرای کامند silent، سپس **Verify**.

### Env سرور Edge (مرجع دستی)

```bash
NODE_ROLE=EDGE
PORT=3000
EDGE_NODE_ID=<uuid-from-panel>
DATABASE_URL=postgresql://spage:PASS@127.0.0.1:5432/spage_edge?schema=public
RABBITMQ_URL=amqp://spage:STRONG@master.internal:5672
RABBITMQ_QUEUE=landing.sync.<short-id>
RABBITMQ_MASTER_QUEUE=form.submission
MASTER_INTERNAL_URL=http://master.internal:3000
```

---

## ۴. همگام‌سازی

1. Confirm روی Master → OutboxEvent
2. Outbox به **همه** صف‌های نود publish می‌کند
3. هر Edge پیام را اعمال می‌کند (idempotent)
4. سابمیشن از Edge به صف Master برمی‌گردد

---

## ۵. چک‌لیست اتصال

| مورد | کجا |
|------|-----|
| نقش | Edge: `EDGE` / Master: `MASTER` |
| صف Edge | پنل → per-node؛ بدون نود → `landing.sync` |
| AMQP | `RABBITMQ_PUBLIC_URL` روی Master |
| Verify | پنل → `GET http://host:port/api/health` |
| `EDGE_NODE_ID` | از bootstrap |

```bash
nc -vz master.internal 5672
curl -fsS "http://127.0.0.1:3000/api/health"
```

---

## ۶. چند Edge

با ثبت نود در پنل، هر Edge صف خودش را دارد و Outbox به همه صف‌ها publish می‌کند. اگر هیچ نودی نباشد، رفتار قبلی (صف مشترک) برای compose محلی حفظ می‌شود.

---

## Env مهم

| متغیر | Master | Edge |
|--------|--------|------|
| `NODE_ROLE` | `MASTER` | `EDGE` |
| `EDGE_NODE_ID` | — | از پنل |
| `RABBITMQ_PUBLIC_URL` | برای bootstrap نود | — |
| `PUBLIC_BASE_URL` | برای کامند نصب | — |
| `SPAGE_GITHUB_REPO` | لینک install-node | — |
| `ADMIN_TOKEN` | بله | لازم نیست |

---

## مسیرهای کد

- `install.sh` / `install-node.sh` — نصب یک‌خطی Master / Edge
- `docker-compose.master.yml` / `docker-compose.node.yml`
- `src/modules/nodes` — CRUD نود، bootstrap، verify
- `src/modules/sync` — Outbox + publish به صف‌های per-node
- `scripts/smoke-test.sh` — تست محلی
