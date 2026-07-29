# SyncPage — Distributed Landing Page Management System

NestJS + PostgreSQL + RabbitMQ (+ Nginx in local compose) supporting two roles:


| User Role  | `NODE_ROLE`                                              | Main Responsibility                                                                                          |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Master** | `MASTER`                                                 | Admin Panel, Form CRUD, Upload/Confirm ZIP, Outbox → Edge, Consume Edge Submissions                          |
| **Edge**   | `EDGE` (or `SLAVE` for temporary backward compatibility) | Serve Landing Pages, Local Form Submissions, Consume `landing.sync`/`form.sync`, Outbox Submissions → Master |


---



## Quick Installation (Production)



### Master Node

```bash
bash <(curl -Ls https://raw.githubusercontent.com/rm1dev/SyncPage/main/install.sh)
```

The script will prompt for setup details (with short English hints). Important fields:

- **Public domain** (optional): landing/CDN hostname only, e.g. `landing.your-domain.com`. Leave empty if unused. **Do not** put `/spadmin` behind the landing load balancer.
- **Dashboard HTTP port**: host port for Master panel/API (default **`1313`**)
- **Master internal URL** / **RabbitMQ URL**: prefer direct server IP (not CDN)
- **Edge on this server?** (default **y**) — separate port (default `3000`)

After installation:

- Admin Panel: **`http://SERVER:1313/spadmin`** (or the dashboard port you chose) — always `/spadmin`
- Master publishes the Nest `app` directly (`docker-compose.master.yml`, no nginx)
- The admin token will be printed in the script output.
- If co-located Edge was installed: `/opt/syncpage-node` and `http://SERVER:3000`



### Edge Node

1. In the Master Admin Panel: navigate to **Node Management → Add Node** (title, IP/hostname, port, etc.)
2. Copy the installation command — **runs fully automated (unattended)**:

```bash
bash <(curl -Ls https://raw.githubusercontent.com/rm1dev/SyncPage/main/install-node.sh) \
  https://MASTER_URL/api/nodes/bootstrap/TOKEN
```

1. Once installed, click **تایید اتصال** in the Admin Panel to mark the node status as `ONLINE`.

Each node maintains a dedicated queue (`landing.sync.<id>`); the Master node broadcasts events to **all** registered nodes.

### Update (Master / Edge)

The Admin panel compares local `package.json` version with GitHub and shows a warning + copyable command when outdated.

```bash
# Master (preserves /opt/syncpage/.env)
bash <(curl -Ls https://raw.githubusercontent.com/rm1dev/SyncPage/main/update.sh)

# Edge node (preserves /opt/syncpage-node/.env)
bash <(curl -Ls https://raw.githubusercontent.com/rm1dev/SyncPage/main/update-node.sh)
```

---



## 1. System Architecture & Topology

```
┌──────────────────────── Master Node (Central) ────────────────────────┐
│  Admin + API  │  Outbox → Edge  │  ZIP packages                       │
│  PostgreSQL   │  RabbitMQ       │  Submission Consumer                │
│  Nodes Panel  │  per-node queues│  Health Verification                │
└───────┬───────────────────────────┬───────────────────────────────────┘
        │ landing.sync / form.sync    │ form.submission
        ▼                             ▲
   queue landing.sync.<node>   queue form.submission
        │                             │
        ▼                             │
┌──────────────────────── Edge Node (Separate Server / CDN) ───────────┐
│  Landing + Form Consumer │ Local Submissions │ Submission Outbox    │
│  PostgreSQL Edge (Form, FormSubmission, Landing…)                    │
└──────────────────────────────────────────────────────────────────────┘
```

- Landing pages and **Form Submissions** are processed directly on Edge nodes.
- Form definitions are pushed from Master to Edge via `form.sync`; submissions are returned to Master via `form.submission.sync`.
- Edge nodes must connect directly to the Master's RabbitMQ broker (`RABBITMQ_PUBLIC_URL`).

---



## 2. Local / Development Setup

```bash
cp .env.example .env
docker compose up --build -d
# Once healthy:
bash scripts/smoke-test.sh
```


| Service                | Endpoint                                                                  |
| ---------------------- | ------------------------------------------------------------------------- |
| Admin Panel            | `http://localhost/spadmin` (default `ADMIN_TOKEN`: `change-me-admin-token`) |
| Landing Pages          | `http://localhost/:slug/`                                                 |
| Form Submission        | `http://localhost/api/forms/:key/submit` → **Edge**                       |
| Management API         | `http://localhost/api/...` → **Master**                                   |
| RabbitMQ Management UI | `http://localhost:15672` (credentials: `syncpage`/`syncpage`)             |


Production Compose files:


| File                        | Purpose                            |
| --------------------------- | ---------------------------------- |
| `docker-compose.master.yml` | Master + Postgres + RabbitMQ (`HTTP_PORT` → app; panel at `/spadmin`) |
| `docker-compose.node.yml`   | Edge + Local Postgres (Remote RMQ) |

On a Master server installed via `install.sh`, always use `docker-compose.master.yml`. Plain `docker compose up` starts the **local** dual-role stack and can conflict on port 80.

### Makefile shortcuts

From the project directory (`/opt/syncpage` on Master):

```bash
make help           # list targets
make master-up      # docker compose -f docker-compose.master.yml --env-file .env up -d
make master-build   # up -d --build
make master-logs    # logs -f
make master-down    # down
make node-up        # Edge stack (docker-compose.node.yml)
make local-up       # local Master+Edge+nginx
make smoke          # scripts/smoke-test.sh
```

Override env file: `make master-up ENV_FILE=.env.prod`


Development without full stack containers:

```bash
cp .env.example .env
npx prisma migrate deploy
npm run start:dev   # NODE_ROLE=MASTER
```

---



## 3. Production: Deploying Edge on a Separate Server



### Network Requirements

Edge servers require connectivity to the following Master services:

1. **Master RabbitMQ** — Port `5672`
2. **Master Package Download Endpoint (HTTP)** — `MASTER_INTERNAL_URL`
3. **Bootstrap API** — Required only during setup: `GET /api/nodes/bootstrap/:token`


| Port        | Usage                   | Recommended Firewall Rule |
| ----------- | ----------------------- | ------------------------- |
| `1313` (default) | Master app → API + `/spadmin` + Bootstrap | Restrict Admin; do not LB with Edge landings |

| `5672`      | AMQP for Edge Nodes     | Whitelist Edge IPs / VPN  |
| `15672`     | RabbitMQ Management UI  | Operators only            |


Recommended workflow: **Add node in Admin Panel**, execute the unattended command on the Edge server, and then click **Verify**.

### Edge Server Env (Manual Reference)

```bash
NODE_ROLE=EDGE
PORT=3000
EDGE_NODE_ID=<uuid-from-panel>
DATABASE_URL=postgresql://syncpage:PASS@127.0.0.1:5432/syncpage_edge?schema=public
RABBITMQ_URL=amqp://syncpage:STRONG@master.internal:5672
RABBITMQ_QUEUE=landing.sync.<short-id>
RABBITMQ_MASTER_QUEUE=form.submission
MASTER_INTERNAL_URL=http://master.internal:3000
```

---



## 4. Synchronization Mechanism

1. Admin confirms package on Master → `OutboxEvent` created.
2. Outbox publisher broadcasts to **all** registered node queues.
3. Each Edge node consumes and applies updates (idempotent operations).
4. Submissions captured on Edge are buffered and returned to Master's submission queue.

---



## 5. Connectivity Checklist


| Item                | Details                                                 |
| ------------------- | ------------------------------------------------------- |
| Role                | Edge: `EDGE` / Master: `MASTER`                         |
| Edge Queue          | Panel → per-node; single node fallback → `landing.sync` |
| AMQP                | Configured via `RABBITMQ_PUBLIC_URL` on Master          |
| Health Verification | Panel → `GET http://host:port/api/health`               |
| `EDGE_NODE_ID`      | Received during bootstrap process                       |


```bash
nc -vz master.internal 5672
curl -fsS "http://127.0.0.1:3000/api/health"
```

---



## 6. Multi-Edge Deployment

When nodes are registered via the Admin Panel, each Edge receives its own dedicated queue, and the Outbox service broadcasts updates to all queues. If no nodes are registered, the system falls back to a shared queue for single-node / local docker-compose environments.

---



## Key Environment Variables


| Variable               | Master                                      | Edge                                |
| ---------------------- | ------------------------------------------- | ----------------------------------- |
| `NODE_ROLE`            | `MASTER`                                    | `EDGE`                              |
| `EDGE_NODE_ID`         | —                                           | Provided by Admin Panel / Bootstrap |
| `RABBITMQ_PUBLIC_URL`  | Used for node bootstrap                     | —                                   |
| `PUBLIC_BASE_URL`      | Used in installation scripts                | —                                   |
| `SYNCPAGE_GITHUB_REPO` | Repository source for `install-node` script | —                                   |
| `ADMIN_TOKEN`          | Required                                    | Not required                        |


---



## Project Structure & Key Paths

- `Makefile` — shortcuts for Master / Edge / local compose (`make help`)
- `install.sh` / `install-node.sh` — One-line installers for Master and Edge nodes
- `update.sh` / `update-node.sh` — One-line updaters (keeps `.env`, rebuilds compose)
- `docker-compose.master.yml` / `docker-compose.node.yml` — Docker orchestration manifests
- `src/modules/nodes` — Node management, bootstrapping, and health verification
- `src/modules/sync` — Outbox publisher and per-node message synchronization
- `scripts/smoke-test.sh` — End-to-end local integration testing script

