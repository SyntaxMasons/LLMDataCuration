# LLMDataCuration

A centralized web application for curating, reviewing, and exporting high-quality AI training datasets from raw HTML knowledge bases.

![Stack](https://img.shields.io/badge/Node.js-18+-green) ![Express](https://img.shields.io/badge/Express-4-blue) ![HTMX](https://img.shields.io/badge/HTMX-1.9-orange) ![SQLite](https://img.shields.io/badge/SQLite-Sequelize-yellow) ![EJS](https://img.shields.io/badge/Templating-EJS-purple)

---

## Features

- **📥 Ingestion** — Import raw HTML documents into the SQLite database
- **🤖 AI Generation** — Auto-generate Q&A pairs from HTML context (pluggable LLM backend)
- **🔍 Reviewer Workflow** — Side-by-side HTML source + Q&A editor with HTMX-powered regeneration
- **✅ Admin Approval Queue** — Two-tier approval with notes, approve/reject per-pair
- **📤 JSONL Export** — One-click download of approved data in fine-tuning format
- **👥 User Management** — Create reviewers and admins, update roles, delete accounts — all via HTMX

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ (ES Modules `.mjs`) |
| Web Framework | Express.js 4 |
| Templating | EJS (server-rendered HTML for HTMX) |
| Database | SQLite via Sequelize ORM |
| Frontend | HTMX 1.9 + Tailwind CSS (CDN) |
| Process Manager | PM2 |

---

## Project Structure

```
LLMDataCuration/
├── server.mjs              # Express server + all route handlers
├── db.mjs                  # Sequelize models (User, Document, QAPair)
├── ai.mjs                  # AI generation service (pluggable LLM module)
├── ecosystem.config.cjs    # PM2 deployment config
├── Dockerfile              # Multi-stage production image
├── .dockerignore
├── .github/workflows/      # CI: build & push to Docker Hub
├── package.json
├── database.sqlite         # Auto-created SQLite file
├── test-db.mjs             # Database verification script
└── views/
    ├── index.ejs           # Main layout & page assembly
    └── partials/
        ├── nav.ejs              # Navigation bar
        ├── reviewer-pane.ejs    # Reviewer split-view
        ├── admin-view.ejs       # Admin panel (user mgmt, queue, export)
        ├── qa-turn.ejs          # Multi-turn Q&A block
        ├── approval-card.ejs    # Admin approval card
        ├── user-row.ejs         # User table row
        └── toast.ejs            # Toast notification
```

---

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Start Development Server

```bash
npm run dev
```

> The server auto-initializes the SQLite database and seeds default users on first run.

### 3. Open the Dashboard

Navigate to: **http://localhost:3000**

---

## Default Seed Accounts

| Username | Password | Role |
|---|---|---|
| `admin_bago` | `password123` | Administrator |
| `masticn_user` | `password123` | Reviewer |

---

## Core Workflows

### Reviewer Workflow
1. Log in as a Reviewer
2. Select or ingest an HTML document from the left pane
3. Review the AI-drafted Q&A pair in the right pane
4. Edit and/or click **Regenerate Answer** (HTMX live swap)
5. Click **Submit for Approval** → pair is saved as `pending_approval`

### Admin Workflow
1. Log in as an Admin
2. Open **Admin Approval → Approval Queue**
3. Review submitted Q&A cards, add notes
4. Click **Approve & Finalize** or **Reject**
5. Export all approved pairs from **Export Data (JSONL)**

### JSONL Export Format

```json
{"messages":[
  {"role":"system","content":"You are a helpful assistant..."},
  {"role":"user","content":"Question based on context..."},
  {"role":"assistant","content":"Accurate, distilled answer..."}
]}
```

---

## API Routes

| Method | Route | HTMX Target | Description |
|---|---|---|---|
| `GET` | `/` | Full page | Main dashboard |
| `POST` | `/api/admin/users` | `#user-table-body` | Create new user (returns row partial) |
| `PUT` | `/api/admin/users/:id/role` | `none` | Update user role |
| `DELETE` | `/api/admin/users/:id` | `#user-row-:id` | Delete user (returns empty → removes row) |
| `POST` | `/api/qa/regenerate` | `#answer-container-*` | AI regenerate answer |
| `GET` | `/api/qa/add-turn` | `#turns-list` | Append new multi-turn block |
| `POST` | `/api/qa/submit` | `#toast-container` | Submit Q&A for approval |
| `POST` | `/api/admin/qa/:id/approve` | `#qa-card-:id` | Approve Q&A pair |
| `POST` | `/api/admin/qa/:id/reject` | `#qa-card-:id` | Reject Q&A pair |
| `POST` | `/api/documents/fetch-url` | `HX-Redirect` | Fetch a KB page from a URL, sanitize it, and create a document |
| `POST` | `/api/documents/ingest` | Redirect | Ingest new HTML document |
| `GET` | `/api/export/jsonl` | Download | Export approved pairs as `.jsonl` |

---

## PM2 Deployment

```bash
# Start with PM2
npm run pm2:start

# View live logs
npm run pm2:logs

# Restart
npm run pm2:restart

# Stop
npm run pm2:stop
```

---

## Docker

The image runs the app as a non-root `node` user and stores SQLite on a volume at `/app/data` (via the `DB_PATH` environment variable).

### Build locally

```bash
docker build -t shreyasnayak21/llmdatacuration:1.0.0 .
```

### Run

```bash
docker run -d --name llm-data-curation \
  -p 3000:3000 \
  --env-file .env \
  -v llm-data-curation-data:/app/data \
  --restart unless-stopped \
  shreyasnayak21/llmdatacuration:1.0.0
```

Open **http://localhost:3000**. The `.env` file is injected at runtime (`--env-file`), so secrets are never baked into the image. The named volume keeps `database.sqlite` across container recreations.

> Use a single container/replica: sessions are stored in memory, and SQLite is single-writer.

### Push to Docker Hub manually

```bash
docker login

docker build -t shreyasnayak21/llmdatacuration:1.0.0 .

# Push the version tag
docker push shreyasnayak21/llmdatacuration:1.0.0

# Optionally also move :latest
docker tag shreyasnayak21/llmdatacuration:1.0.0 shreyasnayak21/llmdatacuration:latest
docker push shreyasnayak21/llmdatacuration:latest
```

### Automated builds with GitHub Actions

Workflow: `.github/workflows/docker-publish.yml`

1. Create a Docker Hub access token: **Docker Hub → Account Settings → Security → New Access Token** with **Read & Write** scope.
2. In GitHub: **Repository → Settings → Secrets and variables → Actions**, add:
   - `DOCKERHUB_USERNAME` = `shreyasnayak21`
   - `DOCKERHUB_TOKEN` = the access token
3. Push to `main`/`master` → publishes `latest`, the branch name, and a short commit SHA tag.
4. Publish a version tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

That builds and pushes `1.0.0`, `1.0`, `1`, `latest`, and the SHA tag to `shreyasnayak21/llmdatacuration`.

Pull requests build the image without pushing. You can also run the workflow manually (**Actions → Docker Build & Push → Run workflow**); a manual run publishes `latest`, the branch name, and a short SHA tag.

---

## Connecting a Real LLM

`ai.mjs` talks to any **OpenAI-compatible** `/chat/completions` endpoint (vLLM, Ollama, LM Studio, OpenAI, …). Configuration lives in `.env` — no code changes are needed:

```env
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=<TOKEN>
LLM_MODEL=gpt-6-luna
# Optional request timeout in milliseconds
LLM_TIMEOUT_MS=60000
```

The model must accept the standard chat-completions request body (`model`, `messages`, `temperature`, `max_tokens`) and return `choices[0].message.content`.

To discover the model IDs a server exposes:

```bash
curl -H "Authorization: Bearer $LLM_API_KEY" "$LLM_BASE_URL/models"
```

If the LLM call fails during ingest, `generateQAPair` falls back to a deterministic canned pair so the reviewer workflow keeps working; failures during **Regenerate Answer** surface as an inline error instead. Check `logs/server.err.log` for `AI generation failed, using fallback`.
