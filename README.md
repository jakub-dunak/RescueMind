RescueMind — Crowd‑Sourced Disaster Response Planner

Overview
- Purpose: Rapidly turn a scenario plus crowd updates into a clear, actionable plan.
- Approach: Static‑first frontend with an optional Cloudflare Worker for AI plans and persistent incident storage.
- Why: Lightweight, fast, and deployable anywhere; privacy‑respecting by default.

Features
- Main App: Incident map, scenario form, crowd updates, instant plan output.
- Update Status: Each update shows “Open/Resolved”; plans only include open items.
- Authority Console: Curate incidents; add/resolve/delete updates; edit metadata.
- Offline‑First: Service Worker for best‑effort offline usage.
- Optional AI: Worker calls Groq models; client falls back to a deterministic template if unavailable.
- Persistence (Prod): Incidents stored in Cloudflare KV via a simple JSON API.

Quick Start (Local, Static)
- Open `index.html` directly or serve the folder: `python3 -m http.server 8000`
- Authority Console: open `authority.html`, click “Connect Incident Folder”, pick `data/incidents/` to edit JSON on disk.
- Optional API dev: `npm i -g wrangler` → copy `.dev.vars.example` to `.dev.vars` → set `GROQ_API_KEY` → `wrangler dev`. Optionally set `window.__PLAN_API__` before `app.js`.

Architecture
- Static Frontend: `index.html`, `app.js`, `styles.css`, `authority.html`, `authority.js`.
- Datasets: `data/incidents/index.json` + one JSON per incident, plus optional cached plans under `data/plans/`.
- Worker Backend: `api/plan-worker.js`
  - `POST /api/plan`: AI plan (cached in PLAN_KV)
  - `GET /data/plans/*`: serve cached plans
  - `GET /data/incidents/*`: serve incidents from DATA_KV
  - `GET /api/incidents`: list (from DATA_KV index)
  - `GET /api/incidents/:id`: fetch one incident
  - `PUT /api/incidents/:id`: upsert incident (Bearer auth)
  - `PATCH /api/incidents/:id/updates`: add/resolve/delete updates (Bearer auth)

Production Deployment (Recommended)
- Frontend: Cloudflare Pages (static files)
- Backend: Cloudflare Worker + KV (same domain routes for `/api/*` and `/data/*`)

1) Cloudflare KV Setup
```bash
wrangler kv:namespace create PLAN_KV
wrangler kv:namespace create PLAN_KV --preview
wrangler kv:namespace create DATA_KV
wrangler kv:namespace create DATA_KV --preview
wrangler kv:namespace create RATE_KV
wrangler kv:namespace create RATE_KV --preview
```
Fill IDs in `wrangler.toml` for PLAN_KV, DATA_KV, RATE_KV.

2) Secrets
```bash
wrangler secret put GROQ_API_KEY
wrangler secret put AUTH_TOKEN
```

3) Seed Incidents into DATA_KV
```bash
# index.json
wrangler kv:key put --binding=DATA_KV data/incidents/index.json --path data/incidents/index.json

# all incident files
for f in data/incidents/*.json; do
  key="data/incidents/$(basename "$f")"
  wrangler kv:key put --binding=DATA_KV "$key" --path "$f"
done
```

4) Deploy Worker
```bash
wrangler deploy
```

5) Deploy Frontend (Pages)
- Create a Pages project (no build step) and set a custom domain.
- Add Worker routes on the same domain:
  - `https://YOUR_DOMAIN/api/*`
  - `https://YOUR_DOMAIN/data/*`
- The app keeps fetching `data/incidents/...` and `POST /api/plan` on the same origin; the Worker serves those paths.

Separate domain? Define before `app.js`:
```html
<script>
  window.__PLAN_API__ = 'https://YOUR_WORKER.example.com/api/plan';
  // If serving incidents cross-origin:
  // window.__DATA_BASE__ = 'https://YOUR_WORKER.example.com';
</script>
```

6) Secure the Authority Console
- Protect `/authority.html` with Cloudflare Access (recommended) or basic auth.
- Worker write endpoints require `Authorization: Bearer <AUTH_TOKEN>`. Do not ship this token to the public app.

Operational Notes
- Plan Caching: PLAN_KV caches plans keyed by incident + open‑updates signature.
- Rate Limiting: Optional RATE_KV throttles `/api/plan` best‑effort per IP.
- Data Model: Incident updates may include `resolved: true`; the main app ignores resolved ones for plan inputs.
- Offline: Static app works without the Worker; AI and persistence are optional upgrades.

API Summary (Worker)
- `POST /api/plan` — Generate plan from `{ scenario, updates, options, incidentId }`.
- `GET /data/plans/<id>.json` — Fetch cached plan wrapper.
- `GET /data/incidents/index.json` — List incidents.
- `GET /data/incidents/<file>.json` — Fetch incident JSON.
- `GET /api/incidents` — List (same as index).
- `GET /api/incidents/:id` — Fetch one incident.
- `PUT /api/incidents/:id` — Upsert incident (Bearer auth).
- `PATCH /api/incidents/:id/updates` — `{ op: 'add'|'resolve'|'delete', ... }` (Bearer auth).

Example `PATCH` payloads
```json
// Add update
{ "op": "add", "text": "Bridge A closed", "ts": "2025-09-11T10:00:00Z" }

// Resolve/unresolve
{ "op": "resolve", "text": "Bridge A closed", "ts": "2025-09-11T10:00:00Z", "resolved": true }

// Delete
{ "op": "delete", "text": "Bridge A closed", "ts": "2025-09-11T10:00:00Z" }
```

License
MIT
