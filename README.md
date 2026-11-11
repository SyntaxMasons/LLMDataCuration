# LLM Data Curation

**LLM Data Curation** is a lightweight web application designed to turn raw HTML knowledge bases into high-quality, structured training data for Large Language Models (LLMs).

![Stack](https://img.shields.io/badge/Node.js-18+-green) ![Express](https://img.shields.io/badge/Express-4-blue) ![HTMX](https://img.shields.io/badge/HTMX-1.9-orange) ![SQLite](https://img.shields.io/badge/SQLite-Sequelize-yellow) ![EJS](https://img.shields.io/badge/Templating-EJS-purple)

---


## 💡 Why do we need this?

Most company knowledge is trapped in unstructured HTML pages. Before you can train or fine-tune an AI model, you need clean, structured Question-and-Answer (Q&A) pairs. This tool bridges that gap by combining automated AI extraction with human review.

### 🔄 How it works in 3 Steps:

1. **Automated Extraction:** The tool connects to an LLM, reads your HTML documents, and automatically drafts Q&A pairs.
2. **Human-in-the-Loop:** Reviewers check the AI's work, edit the text, and submit the best pairs.
3. **Approval & Export:** Administrators approve the final submissions and export them as a ready-to-train dataset.

---

## ✨ Key Features

* **📥 Easy Ingestion** — Import raw HTML documents directly into the database.
* **🤖 AI Auto-Generation** — Automatically generate Q&A pairs using your preferred AI model (OpenAI, vLLM, Ollama, etc.).
* **🔍 Side-by-Side Review** — A clean split-screen UI showing the HTML source next to the Q&A editor.
* **✅ Admin Approval Queue** — Two-tier workflow. Admins can approve, reject, or leave notes on submitted data.
* **📤 Instant JSONL Export** — Download approved data in the standard OpenAI fine-tuning format with one click.
* **👥 User Management** — Easily add, edit, or remove reviewers and admins directly from the dashboard.

---

## 🚀 Getting Started (Local Development)

### 1. Install & Run

Make sure you have Node.js (v18+) installed, then run:

```bash
npm install
npm run dev

```

*Note: The server will automatically create the SQLite database and generate default users on its first run.*

### 2. Log In

Open **http://localhost:3000** in your browser and use one of the default accounts:

| Role | Username | Password |
| --- | --- | --- |
| **Administrator** | `admin_bago` | `password123` |
| **Reviewer** | `masticn_user` | `password123` |

---

## 🧠 Connecting Your AI (LLM)

The app's `ai.mjs` file can connect to **any OpenAI-compatible API** (like OpenAI, vLLM, LM Studio, or Ollama).

You don't need to change any code. Just set your environment variables in a `.env` file:

```env
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=your_api_key_here
LLM_MODEL=gpt-4
LLM_TIMEOUT_MS=60000 

```

*Note: If the AI connection fails during ingestion, the app uses a fallback dummy Q&A pair so your workflow isn't interrupted.*

---

## 🛠️ How to Use the App

### For Reviewers

1. Log in with a Reviewer account.
2. Select an HTML document from the left pane (or ingest a new one).
3. Review the AI-generated Q&A pair on the right.
4. Make edits or click **Regenerate Answer** to get a new AI response.
5. Click **Submit for Approval**.

### For Administrators

1. Log in with an Admin account.
2. Go to **Admin Approval → Approval Queue**.
3. Review submitted Q&A pairs from your team.
4. Click **Approve & Finalize** or **Reject**.
5. Once you have enough approved data, click **Export Data (JSONL)** to download your dataset.

**Exported JSONL Format:**

```json
{"messages":[
  {"role":"system","content":"You are a helpful assistant..."},
  {"role":"user","content":"Question based on context..."},
  {"role":"assistant","content":"Accurate, distilled answer..."}
]}

```

---

## 🐳 Deployment (Docker)

Deploying to production is easiest with Docker. The image runs as a secure non-root user and saves your database to a persistent volume.

**Build the image:**

```bash
docker build -t llmdatacuration:1.0.0 .

```

**Run the container:**

```bash
docker run -d --name llm-data-curation \
  -p 3000:3000 \
  --env-file .env \
  -v llm-data-curation-data:/app/data \
  --restart unless-stopped \
  llmdatacuration:1.0.0

```

*Note: Because the app uses SQLite and in-memory sessions, only run a single replica/container at a time.*

---

## ⚙️ Technical Details

### Tech Stack

* **Backend:** Node.js 18+, Express.js 4
* **Database:** SQLite (via Sequelize ORM)
* **Frontend:** HTMX 1.9, EJS Templates, Tailwind CSS
* **Process Manager:** PM2

### PM2 Commands (For non-Docker servers)

```bash
npm run pm2:start   # Start the app
npm run pm2:logs    # View live logs
npm run pm2:restart # Restart the app
npm run pm2:stop    # Stop the app

```

### API Routes Reference

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/` | Main dashboard |
| `POST` | `/api/admin/users` | Create new user |
| `PUT` | `/api/admin/users/:id/role` | Update user role |
| `DELETE` | `/api/admin/users/:id` | Delete user |
| `POST` | `/api/qa/regenerate` | Ask AI to rewrite the answer |
| `GET` | `/api/qa/add-turn` | Add a new multi-turn block to the editor |
| `POST` | `/api/qa/submit` | Submit Q&A pair to the admin queue |
| `POST` | `/api/admin/qa/:id/approve` | Approve Q&A pair |
| `POST` | `/api/admin/qa/:id/reject` | Reject Q&A pair |
| `POST` | `/api/documents/fetch-url` | Scrape URL and save as an HTML document |
| `POST` | `/api/documents/ingest` | Manually upload/ingest HTML document |
| `GET` | `/api/export/jsonl` | Download approved pairs as `.jsonl` file |