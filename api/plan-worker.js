// Cloudflare Worker: AI proxy for RescueMind (Groq only)
// Usage: Deploy as a Worker; set environment variables:
// - GROQ_API_KEY (required)
//
// Endpoint: POST /api/plan
// Body: { scenario, updates, options, incidentId }
// Returns: Plan JSON matching the client template structure.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return handleOptions();
    // Public: serve incidents JSON from KV under /data/incidents/*
    if (request.method === 'GET' && url.pathname.startsWith('/data/incidents/')) {
      if (!env.DATA_KV) return new Response('Not configured', { status: 501, headers: baseHeaders() });
      const key = url.pathname.slice(1); // e.g., data/incidents/index.json or data/incidents/<file>
      const val = await env.DATA_KV.get(key);
      if (!val) return new Response('Not Found', { status: 404, headers: baseHeaders() });
      return new Response(val, { status: 200, headers: baseHeaders() });
    }
    // Incidents API (Authority writes)
    if (url.pathname.startsWith('/api/incidents')) {
      const segs = url.pathname.split('/').filter(Boolean); // [api, incidents, id, ...]
      const method = request.method.toUpperCase();
      if (!env.DATA_KV) return json({ error: 'DATA_KV not configured' }, 501);
      if (method === 'GET' && segs.length === 2) {
        // List (return index.json content)
        const idx = await env.DATA_KV.get('data/incidents/index.json');
        return idx ? new Response(idx, { status: 200, headers: baseHeaders() }) : json({ incidents: [] }, 200);
      }
      if (method === 'GET' && segs.length === 3) {
        const id = segs[2];
        const fileKey = `data/incidents/${id}.json`;
        const val = await env.DATA_KV.get(fileKey);
        if (!val) return json({ error: 'Not found' }, 404);
        return new Response(val, { status: 200, headers: baseHeaders() });
      }
      // Write operations require bearer token
      const authz = request.headers.get('authorization') || '';
      const token = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7) : '';
      if (!token || token !== env.AUTH_TOKEN) return json({ error: 'Unauthorized' }, 401);
      if (method === 'PUT' && segs.length === 3) {
        const id = segs[2];
        let incident;
        try { incident = await request.json(); } catch (_) { return json({ error: 'Bad JSON' }, 400); }
        if (!incident || typeof incident !== 'object') return json({ error: 'Invalid body' }, 400);
        if ((incident.id || id) !== id) return json({ error: 'ID mismatch' }, 400);
        // Sanitize
        sanitizeIncident(incident);
        const fileName = `${id}.json`;
        const fileKey = `data/incidents/${fileName}`;
        const toWrite = JSON.stringify(incident, null, 2);
        await env.DATA_KV.put(fileKey, toWrite);
        // Maintain manifest index
        const idxRaw = await env.DATA_KV.get('data/incidents/index.json');
        const idx = idxRaw ? JSON.parse(idxRaw) : { incidents: [] };
        const i = idx.incidents.findIndex((x) => x.id === id);
        if (i >= 0) idx.incidents[i] = { id, file: fileName }; else idx.incidents.push({ id, file: fileName });
        await env.DATA_KV.put('data/incidents/index.json', JSON.stringify(idx, null, 2));
        return json({ ok: true, id, file: fileName });
      }
      if (method === 'PATCH' && segs.length === 4 && segs[3] === 'updates') {
        const id = segs[2];
        let body; try { body = await request.json(); } catch(_) { return json({ error: 'Bad JSON' }, 400); }
        const op = body && body.op;
        if (!op) return json({ error: 'Missing op' }, 400);
        const key = `data/incidents/${id}.json`;
        const val = await env.DATA_KV.get(key);
        if (!val) return json({ error: 'Not found' }, 404);
        const inc = JSON.parse(val);
        inc.updates = Array.isArray(inc.updates) ? inc.updates : [];
        if (op === 'add') {
          const t = (body.text || '').trim();
          const ts = body.ts || new Date().toISOString();
          if (!t) return json({ error: 'Missing text' }, 400);
          inc.updates.push({ text: t, ts });
        } else if (op === 'resolve') {
          const ts = body.ts; const resolved = !!body.resolved;
          const u = inc.updates.find((u) => u.ts === ts && u.text === body.text);
          if (!u) return json({ error: 'Update not found' }, 404);
          u.resolved = resolved;
        } else if (op === 'delete') {
          const ts = body.ts; const text = body.text;
          const i = inc.updates.findIndex((u) => u.ts === ts && u.text === text);
          if (i === -1) return json({ error: 'Update not found' }, 404);
          inc.updates.splice(i, 1);
        } else {
          return json({ error: 'Unsupported op' }, 400);
        }
        await env.DATA_KV.put(key, JSON.stringify(inc, null, 2));
        return json({ ok: true });
      }
      return json({ error: 'Not Found' }, 404);
    }
    // Serve stored plans via KV under /data/plans/*
    if (request.method === 'GET' && url.pathname.startsWith('/data/plans/')) {
      if (!env.PLAN_KV) return new Response('Not configured', { status: 501, headers: baseHeaders() });
      const key = url.pathname.slice(1); // e.g., data/plans/index.json or data/plans/<id>.json
      const val = await env.PLAN_KV.get(key);
      if (!val) return new Response('Not Found', { status: 404, headers: baseHeaders() });
      return new Response(val, { status: 200, headers: baseHeaders() });
    }
    if (url.pathname !== '/api/plan' || request.method !== 'POST') {
      return new Response('Not Found', { status: 404, headers: baseHeaders() });
    }
    try {
      const body = await request.json();
      const { scenario = {}, updates = [], options = {}, incidentId } = body || {};

      const clean = sanitizePayload({ scenario, updates, options, incidentId });

      // Basic abuse/rate limiting (per IP per minute; best-effort in-memory)
      const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'anon';
      const ok = await ratelimit(env, ip, 30, 60); // 30 req / 60s
      if (!ok) return json({ error: 'Rate limit exceeded' }, 429);

      const sel = chooseModel(clean);
      const finalModel = sel.resolvedModel; // Groq model name
      const apiKey = env.GROQ_API_KEY;
      if (!apiKey) return json({ error: 'Server not configured' }, 500);
      const temperature = typeof clean.options?.temperature === 'number' ? clean.options.temperature : 0.2;
      const maxTokens = clean.options?.max_tokens || 800;

      const system = `You are RescueMind Planner, a cautious and pragmatic emergency planning assistant.
Return ONLY strict JSON conforming to the schema below — no markdown, no commentary, no code fences.
Schema:
{
  "generatedAt": ISO8601,
  "scenario": {"type": string, "location": string, "population": number, "details": string},
  "inputs": {"resources": string[], "constraints": string[], "updates": {"text": string, "ts": string}[]},
  "summary": string,
  "priorities": string[],
  "actions": string[],
  "resourcesPlan": string[],
  "risks": string[]
}
Rules:
- Be pragmatic and safety-conscious.
- Reflect constraints and crowd updates.
- Translate updates into concrete actions; DO NOT echo them verbatim or use phrases like "Incorporate update".
- Deduplicate/merge overlapping updates; quantify when possible.
- Avoid private data: if inputs include PII (emails, phone numbers, addresses) or sensitive info, REDACT in output.
- Ensure equitable resource allocation (no bias by wealth, race, or status).
- Keep items concise, imperative and actionable; prefer 4–7 items per list.
- If information is missing, make conservative assumptions and call them out in summary.
- Return only valid JSON. No markdown, no extra text.`;

      const user = redactPII(clean);

      // Compute update signature (only updates) to decide regeneration
      const updateSig = await sha256Hex(JSON.stringify(user.updates || []));
      const planKey = `data/plans/${user.incidentId || 'unknown'}.json`;
      const indexKey = 'data/plans/index.json';

      // If PLAN_KV configured and plan exists with same updates, return cached
      if (env.PLAN_KV && user.incidentId) {
        const existing = await env.PLAN_KV.get(planKey);
        if (existing) {
          try {
            const parsed = JSON.parse(existing);
            if (parsed && parsed.__meta && parsed.__meta.updateSig === updateSig && parsed.plan) {
              return json(parsed.plan, 200);
            }
          } catch (_) {}
        }
      }

      // Few-shot examples to strongly anchor JSON shape
      const FEW_SHOTS = [
        {
          u: {
            scenario: { type: 'Flood', location: 'Riverside Town', population: 500, details: 'Rising river, low-lying areas inundated.' },
            updates: [ { text: 'Bridge A closed', ts: '2025-09-11T10:00:00Z' } ],
            options: {}
          },
          a: {
            generatedAt: '2025-09-11T10:05:00Z',
            scenario: { type: 'Flood', location: 'Riverside Town', population: 500, details: 'Rising river, low-lying areas inundated.' },
            inputs: { resources: [], constraints: ['Bridge A closed'], updates: [ { text: 'Bridge A closed', ts: '2025-09-11T10:00:00Z' } ] },
            summary: 'Flood in Riverside Town. 500 people affected. Bridge A is closed; evacuate low-lying areas and route via open roads.',
            priorities: [ 'Evacuate low-lying neighborhoods', 'Open and staff shelters with intake', 'Set up triage near affected zones', 'Secure clean water and sanitation' ],
            actions: [ 'Close unsafe roads and mark detours', 'Coordinate door-to-door checks by teams', 'Deliver bottled water and basic supplies', 'Plan reassessment in 2–4 hours' ],
            resourcesPlan: [ 'Assign volunteers to welfare checks and supply runs', 'Deploy medics to triage points near shelters' ],
            risks: [ 'Limited road access may delay evacuations', 'Secondary flooding if rainfall continues' ]
          }
        },
        {
          u: {
            scenario: { type: 'Wildfire', location: 'Foothills', population: 1200, details: 'Winds shifting; smoke affecting suburbs.' },
            updates: [ { text: 'One-lane access road', ts: '2025-09-10T18:30:00Z' } ],
            options: {}
          },
          a: {
            generatedAt: '2025-09-10T18:35:00Z',
            scenario: { type: 'Wildfire', location: 'Foothills', population: 1200, details: 'Winds shifting; smoke affecting suburbs.' },
            inputs: { resources: [], constraints: ['One-lane access road'], updates: [ { text: 'One-lane access road', ts: '2025-09-10T18:30:00Z' } ] },
            summary: 'Wildfire near Foothills. 1200 affected by smoke and potential spread; access is limited to one lane.',
            priorities: [ 'Protect life at the fire line and evacuate at-risk homes', 'Establish clean-air shelters and distribute masks', 'Stage resources for rapid containment' ],
            actions: [ 'Set traffic control for the one-lane road', 'Distribute N95 masks at community centers', 'Alert clinics for respiratory cases', 'Reassess perimeter and winds every 2 hours' ],
            resourcesPlan: [ 'Assign engines and water tenders to protect structures', 'Volunteers handle mask distribution and welfare checks' ],
            risks: [ 'Road bottlenecks may slow evacuations', 'Shifting winds can accelerate fire spread' ]
          }
        },
        {
          u: {
            scenario: { type: 'Hurricane', location: 'Coastal City', population: 3200, details: 'Storm surge risk; shelters being prepared.' },
            updates: [ { text: '10 people are in critical condition and need immediate medical help', ts: '2025-09-11T09:30:00Z' } ],
            options: {}
          },
          a: {
            generatedAt: '2025-09-11T09:35:00Z',
            scenario: { type: 'Hurricane', location: 'Coastal City', population: 3200, details: 'Storm surge risk; shelters being prepared.' },
            inputs: { resources: [], constraints: [], updates: [ { text: '10 people are in critical condition and need immediate medical help', ts: '2025-09-11T09:30:00Z' } ] },
            summary: 'Coastal City preparing for storm surge; immediate medical support required for critical patients.',
            priorities: [ 'Stabilize critical patients', 'Open and staff shelters', 'Pre-position supplies and medical support' ],
            actions: [ 'Dispatch medical teams and ambulances to treat ~10 critical patients; establish triage', 'Coordinate transport to nearest hospitals', 'Reassess in 2–4 hours' ],
            resourcesPlan: [ 'Assign medics to triage stations near shelters', 'Ensure ambulance availability and routes' ],
            risks: [ 'Hospital capacity constraints', 'Power loss impacting medical equipment' ]
          }
        }
      ];

      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(FEW_SHOTS[0].u) },
        { role: 'assistant', content: JSON.stringify(FEW_SHOTS[0].a) },
        { role: 'user', content: JSON.stringify(FEW_SHOTS[1].u) },
        { role: 'assistant', content: JSON.stringify(FEW_SHOTS[1].a) },
        { role: 'user', content: JSON.stringify(FEW_SHOTS[2].u) },
        { role: 'assistant', content: JSON.stringify(FEW_SHOTS[2].a) },
        { role: 'user', content: JSON.stringify(user) }
      ];

      const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };

      // Try primary model; on error, try a couple of sensible variants
      const tried = [];
      async function tryModel(modelName) {
        tried.push(modelName);
        const body = { model: modelName, messages, temperature, max_tokens: maxTokens };
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST', headers, body: JSON.stringify(body)
        });
        return r;
      }

      let resp = await tryModel(finalModel);
      if (!resp.ok) {
        // Fallback variants for GPT‑OSS names some environments expose as *-latest
        const variants = finalModel.includes('gpt-oss-')
          ? [ `${finalModel}-latest`, `${finalModel}-preview` ]
          : [];
        for (const v of variants) {
          const r = await tryModel(v);
          if (r.ok) { resp = r; break; }
        }
      }

      if (!resp.ok) {
        let text = '';
        try { text = await resp.text(); } catch (_) {}
        try { console.error('Groq upstream error', { status: resp.status, tried, body: text?.slice(0,500) }); } catch(_) {}
        return json({ error: 'Upstream error', status: resp.status, tried, upstream: text?.slice(0, 500) }, 502);
      }
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content || '';
      // Robust JSON extraction
      const plan = extractJson(content);
      if (!plan) {
        try { console.error('Invalid model response content snippet:', content.slice(0, 500)); } catch(_) {}
        return json({ error: 'Invalid model response', raw: content?.slice(0, 500) }, 500);
      }
      // Store plan if KV configured
      if (env.PLAN_KV && user.incidentId) {
        const wrapped = { plan, __meta: { updateSig, model: finalModel, generatedAt: new Date().toISOString() } };
        await env.PLAN_KV.put(planKey, JSON.stringify(wrapped));
        try {
          const idxRaw = await env.PLAN_KV.get(indexKey);
          const idx = idxRaw ? JSON.parse(idxRaw) : { plans: [] };
          const file = `data/plans/${user.incidentId}.json`;
          const existing = idx.plans.find((p) => p.id === user.incidentId);
          if (existing) { existing.file = file; existing.updatedAt = new Date().toISOString(); }
          else idx.plans.push({ id: user.incidentId, file, updatedAt: new Date().toISOString() });
          await env.PLAN_KV.put(indexKey, JSON.stringify(idx));
        } catch (_) {}
      }
      return json(plan, 200);
    } catch (e) {
      return json({ error: 'Bad Request' }, 400);
    }
  }
};

function baseHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: baseHeaders() });
}

// Best-effort IP ratelimit using KV or in-memory Durable alternative
async function ratelimit(env, key, limit, windowSec) {
  // If a KV namespace is bound as RATE_KV, use it; else no-op allows basic limiting attempt with memory.
  if (!env.RATE_KV) return true;
  const bucketKey = `rate:${key}`;
  const raw = await env.RATE_KV.get(bucketKey);
  const now = Math.floor(Date.now() / 1000);
  let obj = raw ? JSON.parse(raw) : { count: 0, reset: now + windowSec };
  if (now > obj.reset) obj = { count: 0, reset: now + windowSec };
  if (obj.count >= limit) return false;
  obj.count += 1;
  await env.RATE_KV.put(bucketKey, JSON.stringify(obj), { expirationTtl: windowSec });
  return true;
}

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      ...baseHeaders(),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, authorization',
    }
  });
}

function redactPII(obj) {
  const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const phone = /\+?\d?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
  const url = /https?:\/\/[^\s]+/gi;
  const red = (s) => (typeof s === 'string' ? s.replace(email, '[REDACTED]').replace(phone, '[REDACTED]').replace(url, '[LINK]') : s);
  const out = structuredClone ? structuredClone(obj) : JSON.parse(JSON.stringify(obj));
  out.scenario.details = red(out.scenario.details);
  out.scenario.location = red(out.scenario.location);
  out.updates = (out.updates || []).map(u => ({ text: red(u.text), ts: u.ts }));
  return out;
}

function sanitizePayload({ scenario = {}, updates = [], options = {}, incidentId = '' }) {
  function s(x, max = 400) {
    if (typeof x !== 'string') return '';
    const t = x.trim();
    return t.length > max ? t.slice(0, max) : t;
  }
  function num(n, def = 0) {
    const v = Number(n);
    return Number.isFinite(v) ? v : def;
  }
  const cleanScenario = {
    type: s(scenario.type || '', 60),
    location: s(scenario.location || '', 120),
    population: Math.max(0, Math.min(10_000_000, num(scenario.population || 0))),
    details: s(scenario.details || '', 1200),
  };
  const cleanUpdates = Array.isArray(updates) ? updates.slice(0, 25).map(u => ({
    text: s(u.text || '', 280),
    ts: s(u.ts || '', 40),
  })) : [];
  const cleanOptions = {
    model: s(options.model || '', 64),
    temperature: typeof options.temperature === 'number' ? Math.max(0, Math.min(1, options.temperature)) : 0.2,
    max_tokens: Math.max(200, Math.min(1600, num(options.max_tokens || 800))),
  };
  return { scenario: cleanScenario, updates: cleanUpdates, options: cleanOptions, incidentId: s(incidentId || '', 80) };
}

function sanitizeIncident(incident) {
  const s = (x, max) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
  incident.id = s(incident.id || '', 120);
  incident.name = s(incident.name || '', 120);
  incident.type = s(incident.type || 'Other', 40);
  incident.status = s(incident.status || 'ongoing', 40);
  incident.population = Math.max(0, Math.min(10_000_000, Number(incident.population || 0)));
  incident.resources = s(incident.resources || '', 1200);
  incident.constraints = s(incident.constraints || '', 1200);
  incident.details = s(incident.details || '', 2400);
  incident.lat = Number(incident.lat || 0);
  incident.lng = Number(incident.lng || 0);
  if (!Array.isArray(incident.updates)) incident.updates = [];
  incident.updates = incident.updates.slice(0, 500).map(u => ({ text: s(u.text || '', 280), ts: s(u.ts || '', 60), resolved: !!u.resolved }));
  return incident;
}

function chooseModel(clean) {
  // If explicitly requested, honor; normalize short names to Groq's openai/* IDs
  const explicitRaw = (clean.options && clean.options.model) || '';
  const explicit = explicitRaw.toLowerCase();
  if (explicit) {
    if (explicit.startsWith('openai/')) return { resolvedModel: explicitRaw };
    if (explicit === 'gpt-oss-20b') return { resolvedModel: 'openai/gpt-oss-20b' };
    if (explicit === 'gpt-oss-120b') return { resolvedModel: 'openai/gpt-oss-120b' };
    return { resolvedModel: explicitRaw };
  }
  // Heuristic: complex scenarios → gpt-oss-120b, otherwise gpt-oss-20b
  const detailsLen = (clean.scenario?.details || '').length;
  const population = clean.scenario?.population || 0;
  const updatesCount = Array.isArray(clean.updates) ? clean.updates.length : 0;
  const score = (detailsLen / 600) + (population / 1500) + (updatesCount / 6);
  const heavy = population >= 1500 || detailsLen >= 800 || score >= 3;
  return { resolvedModel: heavy ? 'openai/gpt-oss-120b' : 'openai/gpt-oss-20b' };
}

function extractJson(content) {
  if (!content || typeof content !== 'string') return null;
  // 1) direct parse
  try { return JSON.parse(content); } catch (_) {}
  // 2) code-fence ```json ... ```
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch (_) {}
  }
  // 3) first '{' to matching '}' attempt (greedy to last '}')
  const first = content.indexOf('{');
  const last = content.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const slice = content.slice(first, last + 1);
    try { return JSON.parse(slice); } catch (_) {}
  }
  // 4) Progressive end trimming to find a valid JSON block
  if (first !== -1) {
    for (let i = content.length; i > first; i--) {
      const slice = content.slice(first, i);
      try { return JSON.parse(slice); } catch (_) {}
    }
  }
  return null;
}
async function sha256Hex(str) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  const arr = Array.from(new Uint8Array(buf));
  return arr.map(b => b.toString(16).padStart(2, '0')).join('');
}
