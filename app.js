/*
  RescueMind — Static-first MVP logic
  - Reads form inputs + crowd updates
  - Generates a simple, actionable plan using a client-side template
  - Provides copy and JSON export utilities
  - Optional: wire to an API proxy by toggling API_CONFIG
*/

(function () {
  'use strict';

  // API configuration
  const API_CONFIG = {
    enabled: true,
    // For local dev, default to Wrangler at 127.0.0.1:8787. Allow override via window.__PLAN_API__.
    endpoint: (window.__PLAN_API__ || (location.port === '8787' ? '/api/plan' : 'http://127.0.0.1:8787/api/plan')),
    timeoutMs: 30000,
  };

  // Data base configuration for incidents/plans fetches
  const DATA_BASE = (window.__DATA_BASE__ || '');
  const dataUrl = (path) => (DATA_BASE ? `${DATA_BASE.replace(/\/$/, '')}/${path.replace(/^\//, '')}` : path);

  const els = {
    form: document.getElementById('scenario-form'),
    type: document.getElementById('disaster-type'),
    location: document.getElementById('location'),
    population: document.getElementById('population'),
    resources: document.getElementById('resources'),
    constraints: document.getElementById('constraints'),
    details: document.getElementById('details'),
    updateText: document.getElementById('update-text'),
    addUpdate: document.getElementById('add-update'),
    updatesList: document.getElementById('updates-list'),
    reset: document.getElementById('reset-form'),
    copy: document.getElementById('copy-plan'),
    export: document.getElementById('export-json'),
    empty: document.getElementById('empty-state'),
    plan: document.getElementById('plan-output'),
    incidentSelect: document.getElementById('incident-select'),
    incidentsList: document.getElementById('incidents-list'),
    loadIncidentBtn: document.getElementById('load-incident'),
    locateMe: document.getElementById('locate-me'),
    nearbyOnly: document.getElementById('nearby-only'),
    incidentSearch: document.getElementById('incident-search'),
    shareLink: document.getElementById('share-link'),
    printPlan: document.getElementById('print-plan'),
    newIncident: {
      name: document.getElementById('ni-name'),
      type: document.getElementById('ni-type'),
      lat: document.getElementById('ni-lat'),
      lng: document.getElementById('ni-lng'),
      useLoc: document.getElementById('ni-use-location'),
      add: document.getElementById('ni-add'),
    },
  };

  const state = {
    updates: [],
    lastPlan: null,
    disasters: [],
    currentIncidentId: null,
    map: null,
    markers: [],
    userLocation: null, // { lat, lng }
    history: [],
    clientId: `${Math.random().toString(36).slice(2)}-${Date.now()}`,
    bc: null,
    
    searchQuery: '',
  };

  // Utilities
  function nowIso() { return new Date().toISOString(); }
  function byId(id) { return document.getElementById(id); }
  function sanitize(text) { return String(text ?? '').trim(); }

  // Simple debounce utility
  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  const recomputePlan = debounce(async () => {
    const payload = readForm();
    els.plan && els.plan.setAttribute('aria-busy', 'true');
    await requestPlanFromApi(payload);
    els.plan && els.plan.setAttribute('aria-busy', 'false');
  }, 700);

  function readForm() {
    return {
      type: sanitize(els.type.value),
      location: sanitize(els.location.value),
      population: Number(els.population.value || 0),
      resources: sanitize(els.resources.value),
      constraints: sanitize(els.constraints.value),
      details: sanitize(els.details.value),
      // Only include unresolved updates when generating a plan
      updates: state.updates.filter(u => !u.resolved).map(u => ({ text: u.text, ts: u.ts })),
      incidentId: state.currentIncidentId,
    };
  }

  

  function renderUpdates() {
    const ul = els.updatesList;
    ul.innerHTML = '';
    // Sort: unresolved first, then by timestamp asc
    const items = [...state.updates].sort((a, b) => {
      const ra = a.resolved ? 1 : 0;
      const rb = b.resolved ? 1 : 0;
      if (ra !== rb) return ra - rb;
      const ta = Date.parse(a.ts || '') || 0;
      const tb = Date.parse(b.ts || '') || 0;
      return ta - tb;
    });
    items.forEach((u) => {
      const li = document.createElement('li');
      if (u.resolved) li.classList.add('resolved');
      const text = document.createElement('div');
      text.textContent = u.text;
      const meta = document.createElement('time');
      meta.dateTime = u.ts;
      meta.textContent = new Date(u.ts).toLocaleString();
      meta.className = 'meta';
      li.appendChild(text);
      const right = document.createElement('div');
      right.style.display = 'grid';
      right.style.gap = '6px';
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = u.resolved ? 'Resolved' : 'Open';
      right.appendChild(badge);
      right.appendChild(meta);
      li.appendChild(right);
      ul.appendChild(li);
    });
  }

  // Disaster dataset loading and rendering
  async function loadDisasters() {
    try {
      // Prefer split-file manifest if present
      const man = await fetch(dataUrl('data/incidents/index.json'), { cache: 'no-cache' });
      if (man.ok) {
        const manifest = await man.json();
        const items = Array.isArray(manifest.incidents) ? manifest.incidents : [];
        const incidents = await Promise.all(items.map(async (it) => {
          const r = await fetch(dataUrl(`data/incidents/${it.file}`), { cache: 'no-cache' });
          if (!r.ok) throw new Error(`Failed to load ${it.file}`);
          return r.json();
        }));
        state.disasters = incidents;
        renderDisasters();
        ensureMap();
        plotMarkers();
        return;
      }
    } catch (_) {}
    // Fallback to legacy disasters.json
    try {
      const res = await fetch(dataUrl('data/disasters.json'), { cache: 'no-cache' });
      if (!res.ok) throw new Error('Failed to load disasters');
      const data = await res.json();
      state.disasters = Array.isArray(data.incidents) ? data.incidents : [];
      renderDisasters();
      ensureMap();
      plotMarkers();
    } catch (e) {
      console.warn('No disasters dataset found or failed to load.', e);
      ensureMap();
    }
  }

  function renderDisasters() {
    // populate select
    if (els.incidentSelect) {
      els.incidentSelect.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = state.disasters.length ? 'Select an incident…' : 'No incidents available';
      els.incidentSelect.appendChild(placeholder);
      filteredIncidents().forEach(inc => {
        const o = document.createElement('option');
        o.value = inc.id;
        o.textContent = `${inc.name} · ${inc.type}`;
        els.incidentSelect.appendChild(o);
      });
    }

    // render list
    if (els.incidentsList) {
      els.incidentsList.innerHTML = '';
      filteredIncidents().forEach(inc => {
        const li = document.createElement('li');
        const left = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'incident-title';
        title.textContent = inc.name;
        const meta = document.createElement('div');
        meta.className = 'incident-meta';
        let metaText = `${inc.type} · ${inc.status} · ${inc.population} affected`;
        if (state.userLocation) {
          const km = haversineKm(state.userLocation, inc);
          metaText += ` · ${km.toFixed(1)} km away`;
        }
        meta.textContent = metaText;
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = inc.status;
        title.appendChild(badge);
        left.appendChild(title);
        left.appendChild(meta);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn';
        btn.textContent = 'Use';
        btn.addEventListener('click', () => useIncident(inc.id));
        li.appendChild(left);
        li.appendChild(btn);
        els.incidentsList.appendChild(li);
      });
    }
  }

  function useIncident(id) {
    const inc = state.disasters.find(d => d.id === id);
    if (!inc) return;
    state.currentIncidentId = inc.id;
    // Load into form
    els.type.value = inc.type || 'Other';
    els.location.value = `${inc.name}`;
    els.population.value = inc.population || '';
    els.resources.value = inc.resources || '';
    els.constraints.value = inc.constraints || '';
    els.details.value = inc.details || '';
    // Load all updates; plan generation will ignore resolved ones
    state.updates = Array.isArray(inc.updates)
      ? inc.updates.map(u => ({ text: u.text, ts: u.ts, resolved: !!u.resolved }))
      : [];
    renderUpdates();
    // Try to load a stored plan for this incident
    fetchStoredPlan(id).then(plan => { if (plan) renderPlan(plan); });
    // Select in dropdown
    if (els.incidentSelect) els.incidentSelect.value = id;
    // Focus map and update hash
    focusMapOnIncident(id);
    updateHash(id);
    // Broadcast selection to other tabs
    if (state.bc) state.bc.postMessage({ t: 'select', id, from: state.clientId });
  }

  async function fetchStoredPlan(id) {
    try {
      const base = (window.__PLAN_API__ && window.__PLAN_API__.replace('/api/plan','')) || 'http://127.0.0.1:8787';
      const res = await fetch(`${base}/data/plans/${id}.json`, { cache: 'no-cache' });
      if (!res.ok) return null;
      const data = await res.json();
      return data.plan || data;
    } catch (_) { return null; }
  }

  // Map logic
  function ensureMap() {
    const el = document.getElementById('map');
    if (!el) return;
    if (!window.L) {
      // Fallback if Leaflet is unavailable (offline or blocked)
      el.classList.add('map--fallback');
      el.innerHTML = '<div class="map-fallback">Map unavailable — check connection.</div>';
      return;
    }
    if (state.map) return;
    state.map = L.map(el, { scrollWheelZoom: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(state.map);
    if (state.disasters.length) {
      const group = L.featureGroup(state.disasters.map(d => L.marker([d.lat, d.lng])));
      state.map.fitBounds(group.getBounds().pad(0.3));
    } else {
      state.map.setView([20, 0], 2);
    }
    setTimeout(() => state.map && state.map.invalidateSize(), 0);
  }

  function clearMarkers() {
    state.markers.forEach(m => m.remove());
    state.markers = [];
  }

  function plotMarkers() {
    if (!state.map || !window.L) return;
    clearMarkers();
    const incs = filteredIncidents();
    const clusters = buildClusters(incs);
    clusters.forEach(cl => {
      if (cl.items.length === 1) {
        const inc = cl.items[0];
        const marker = L.marker([inc.lat, inc.lng]).addTo(state.map);
        marker.on('click', () => useIncident(inc.id));
        state.markers.push(marker);
      } else {
        const icon = L.divIcon({ className: 'cluster-marker', html: String(cl.items.length) });
        const marker = L.marker([cl.lat, cl.lng], { icon }).addTo(state.map);
        marker.on('click', () => {
          state.map.setView([cl.lat, cl.lng], Math.min(18, (state.map.getZoom() || 10) + 2));
        });
        state.markers.push(marker);
      }
    });
  }

  function buildClusters(items) {
    const zoom = state.map ? state.map.getZoom() : 10;
    // Approx km per pixel at equator
    const kmPerPx = 156.543 / Math.pow(2, zoom);
    const radiusKm = kmPerPx * 40; // ~40px radius
    const clusters = [];
    for (const it of items) {
      let found = null;
      for (const c of clusters) {
        const d = haversineKm({ lat: c.lat, lng: c.lng }, { lat: it.lat, lng: it.lng });
        if (d <= radiusKm) { found = c; break; }
      }
      if (found) {
        found.items.push(it);
        // Recompute centroid
        const n = found.items.length;
        found.lat = (found.lat * (n - 1) + it.lat) / n;
        found.lng = (found.lng * (n - 1) + it.lng) / n;
      } else {
        clusters.push({ lat: it.lat, lng: it.lng, items: [it] });
      }
    }
    return clusters;
  }

  function focusMapOnIncident(id) {
    if (!state.map) return;
    const inc = state.disasters.find(d => d.id === id);
    if (!inc) return;
    state.map.setView([inc.lat, inc.lng], Math.max(12, state.map.getZoom()));
    state.map.invalidateSize();
  }

  // Distance helpers and filtering
  function toRad(x) { return x * Math.PI / 180; }
  function haversineKm(a, b) {
    const R = 6371;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat/2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function filteredIncidents() {
    let list = state.disasters.slice();
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      list = list.filter(d => (d.name||'').toLowerCase().includes(q) || (d.type||'').toLowerCase().includes(q));
    }
    if (els.nearbyOnly && els.nearbyOnly.checked && state.userLocation) {
      list = list.filter(d => haversineKm(state.userLocation, { lat: d.lat, lng: d.lng }) <= 25);
    }
    if (state.userLocation) {
      list.sort((a, b) => haversineKm(state.userLocation, a) - haversineKm(state.userLocation, b));
    }
    return list;
  }

  async function locateMe() {
    if (!('geolocation' in navigator)) return false;
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition((pos) => {
        state.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        if (state.map) state.map.setView([state.userLocation.lat, state.userLocation.lng], 11);
        renderDisasters();
        plotMarkers();
        resolve(true);
      }, () => resolve(false), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
    });
  }

  async function ipLocate() {
    try {
      const res = await fetch('https://get.geojs.io/v1/ip/geo.json');
      if (res.ok) {
        const g = await res.json();
        const lat = parseFloat(g.latitude), lng = parseFloat(g.longitude);
        if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
          state.userLocation = { lat, lng };
          if (state.map) state.map.setView([lat, lng], 10);
          renderDisasters();
          plotMarkers();
          return true;
        }
      }
    } catch (_) { /* ignore */ }
    return false;
  }

  async function locateBestEffort() {
    let ok = await locateMe();
    if (!ok) ok = await ipLocate();
    return ok;
  }

  // Hash routing
  function updateHash(id) { if (location.hash !== `#incident/${id}`) location.hash = `#incident/${id}`; }
  function handleHash() {
    const m = location.hash.match(/^#incident\/(.+)$/);
    if (m) useIncident(m[1]);
  }

  function addUpdateFromInput() {
    const t = sanitize(els.updateText.value);
    if (!t) return;
    if (t.length > 280) { alert('Update too long (max 280 characters).'); return; }
    state.updates.push({ text: t, ts: nowIso(), resolved: false });
    els.updateText.value = '';
    renderUpdates();
    recomputePlan();
    state.history.push({ ts: nowIso(), type: 'update', text: t });
    // Broadcast update to other tabs for the same incident
    if (state.bc && state.currentIncidentId) state.bc.postMessage({ t: 'update', id: state.currentIncidentId, update: { text: t, ts: nowIso(), resolved: false }, from: state.clientId });
  }

  // Simple, deterministic plan generator for static mode
  function generatePlanFromTemplate(data) {
    const { type, location, population, resources, constraints, details, updates } = data;

    const parsedResources = resources
      .split(/[,;\n]/)
      .map(sanitize)
      .filter(Boolean);
    const parsedConstraints = constraints
      .split(/[,;\n]/)
      .map(sanitize)
      .filter(Boolean);

    // Heuristics for priorities
    const priorities = [];
    if (/flood/i.test(type) || /flood/i.test(details)) priorities.push('Evacuate low-lying areas and establish safe shelter routes');
    if (/fire|wildfire/i.test(type) || /smoke/i.test(details)) priorities.push('Protect life near fire line and secure clean air zones');
    if (/earthquake/i.test(type)) priorities.push('Assess structural damage and cordon unsafe buildings');
    if (/hurricane|storm/i.test(type)) priorities.push('Secure shelters, pre-position supplies, and prepare for power loss');
    if (population > 0) priorities.push(`Triage and support approximately ${population} affected individuals`);
    if (!priorities.length) priorities.push('Stabilize immediate threats to life and secure essential services');

    // Actions derive from resources/constraints/updates
    const actions = [];
    if (parsedResources.length) actions.push(`Allocate available resources: ${parsedResources.join('; ')}`);
    if (parsedConstraints.length) actions.push(`Mitigate constraints: ${parsedConstraints.join('; ')}`);
    updates.slice(0, 5).forEach((u) => {
      const a = transformUpdateToAction(u.text);
      if (a) actions.push(a);
    });
    actions.push('Establish a 2–4 hour reassessment cycle and update plan');

    // Basic resource allocation
    const resourcesPlan = [];
    const hasMedics = parsedResources.some(r => /medic|emt|ambulance/i.test(r));
    const hasVolunteers = parsedResources.some(r => /volunteer|team|staff/i.test(r));
    const hasShelter = parsedResources.some(r => /shelter|center|hall/i.test(r));
    if (hasMedics) resourcesPlan.push('Deploy medical teams to triage points near affected zones');
    if (hasVolunteers) resourcesPlan.push('Assign volunteers to door-to-door checks and supply lines');
    if (hasShelter) resourcesPlan.push('Stand up shelters with intake, supplies, and sanitation');
    if (!resourcesPlan.length) resourcesPlan.push('Request additional resources via mutual aid and NGO partners');

    // Risk notes
    const risks = [];
    if (parsedConstraints.some(c => /bridge|road|access/i.test(c))) risks.push('Limited road access may delay evacuations');
    if (parsedConstraints.some(c => /power|electric/i.test(c))) risks.push('Power outages could impact medical and communications capacity');
    if (!risks.length) risks.push('Monitor evolving conditions and secondary hazards');

    return {
      generatedAt: nowIso(),
      scenario: { type, location, population, details },
      inputs: { resources: parsedResources, constraints: parsedConstraints, updates },
      summary: `${type} in ${location || 'the affected area'}. ${population ? population + ' people affected. ' : ''}${details}`.trim(),
      priorities,
      actions,
      resourcesPlan,
      risks,
    };
  }

  function transformUpdateToAction(text) {
    const t = (text || '').trim();
    if (!t) return '';
    const l = t.toLowerCase();
    // Medical emergencies
    if (/\b(critical|injur|wound|medic|ambulance|triage)\b/.test(l)) {
      const m = t.match(/(\d+)/);
      const n = m ? m[1] : '';
      return `Dispatch medical teams${n ? ` to treat ~${n} critical patients` : ''}; establish triage and transport to nearest care.`;
    }
    // Access/road/bridge closures
    if (/(bridge|road|highway|access|route).*(closed|blocked|down)|\b(road|bridge)\b.*\b(closed|blocked)\b/.test(l)) {
      return 'Reroute evacuations and logistics; update detours and communicate alternate routes.';
    }
    // Power outages
    if (/(power|electric|grid).*out(age)?/.test(l)) {
      return 'Deploy generators and lighting to critical facilities; prioritize vulnerable areas.';
    }
    // Shelter capacity/opening
    if (/(shelter|center|gym).*\b(open|capacity|full)\b/.test(l)) {
      return 'Open additional shelters or expand capacity; ensure intake, sanitation, and supplies.';
    }
    // Water/contamination
    if (/(water).*\b(boil|unsafe|contaminat)/.test(l)) {
      return 'Issue boil-water advisory; distribute bottled water and purification kits.';
    }
    // Generic fallback: convert statement to imperative action
    return `Act on update: ${t}`;
  }

  function planToText(plan) {
    const lines = [];
    lines.push(`RescueMind Plan — ${new Date(plan.generatedAt).toLocaleString()}`);
    lines.push(`Scenario: ${plan.scenario.type} — ${plan.scenario.location}`);
    if (plan.scenario.population) lines.push(`Affected: ${plan.scenario.population}`);
    if (plan.summary) lines.push('Summary: ' + plan.summary);
    lines.push('');
    lines.push('Priorities:');
    plan.priorities.forEach((p, i) => lines.push(`  ${i + 1}. ${p}`));
    lines.push('');
    lines.push('Key Actions:');
    plan.actions.forEach((a, i) => lines.push(`  - ${a}`));
    lines.push('');
    lines.push('Resource Allocation:');
    plan.resourcesPlan.forEach((r, i) => lines.push(`  - ${r}`));
    lines.push('');
    lines.push('Risks:');
    plan.risks.forEach((r, i) => lines.push(`  - ${r}`));
    return lines.join('\n');
  }

  function renderPlan(plan) {
    state.lastPlan = plan;
    state.history.push({ ts: nowIso(), type: 'plan', plan });
    els.empty.style.display = 'none';
    els.plan.innerHTML = '';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `Generated ${new Date(plan.generatedAt).toLocaleString()} · ${plan.scenario.type}${plan.scenario.location ? ' · ' + plan.scenario.location : ''}`;
    els.plan.appendChild(meta);

    function section(title, contentNode) {
      const s = document.createElement('section');
      s.className = 'section';
      const h = document.createElement('h3');
      h.textContent = title;
      s.appendChild(h);
      s.appendChild(contentNode);
      els.plan.appendChild(s);
    }

    const sum = document.createElement('p');
    sum.textContent = plan.summary;
    section('Summary', sum);

    const pri = document.createElement('ul');
    plan.priorities.forEach(p => { const li = document.createElement('li'); li.textContent = p; pri.appendChild(li); });
    section('Priorities', pri);

    const act = document.createElement('ul');
    plan.actions.forEach(a => { const li = document.createElement('li'); li.textContent = a; act.appendChild(li); });
    section('Key Actions', act);

    const res = document.createElement('ul');
    plan.resourcesPlan.forEach(r => { const li = document.createElement('li'); li.textContent = r; res.appendChild(li); });
    section('Resource Allocation', res);

    const risk = document.createElement('ul');
    plan.risks.forEach(r => { const li = document.createElement('li'); li.textContent = r; risk.appendChild(li); });
    section('Risks', risk);

    const tl = document.createElement('ul');
    state.history.slice(-10).forEach(entry => {
      const li = document.createElement('li');
      if (entry.type === 'plan') li.textContent = `${new Date(entry.ts).toLocaleString()}: Plan generated`;
      if (entry.type === 'update') li.textContent = `${new Date(entry.ts).toLocaleString()}: Update — ${entry.text}`;
      tl.appendChild(li);
    });
    section('Timeline', tl);
  }

  async function maybeCallApi(payload) {
    if (!API_CONFIG.enabled) return null;
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), API_CONFIG.timeoutMs);
    try {
      const res = await fetch(API_CONFIG.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return await res.json();
    } finally { clearTimeout(to); }
  }

  function selectModelForPayload(p) {
    const detailsLen = (p.details || '').length;
    const population = p.population || 0;
    const updatesCount = Array.isArray(p.updates) ? p.updates.length : 0;
    const score = (detailsLen / 600) + (population / 1500) + (updatesCount / 6);
    const heavy = population >= 1500 || detailsLen >= 800 || score >= 3;
    return heavy ? 'openai/gpt-oss-120b' : 'openai/gpt-oss-20b';
  }

  async function requestPlanFromApi(payload) {
    // Guard against out-of-order responses
    state.apiSeq = (state.apiSeq || 0) + 1;
    const seq = state.apiSeq;
    state.apiLatest = seq;
    try {
      const model = selectModelForPayload(payload);
      const apiPlan = await maybeCallApi({ ...payload, options: { model } });
      if (seq !== state.apiLatest) return; // stale response
      if (apiPlan) return renderPlan(apiPlan);
    } catch (e) {
      if (seq !== state.apiLatest) return; // stale response
      console.warn('API plan failed, falling back', e);
    }
    if (seq === state.apiLatest) renderPlan(generatePlanFromTemplate(payload));
  }

  // requestPlanFromApi: removed UI controls; local template used by default

  // Event wiring
  els.addUpdate.addEventListener('click', addUpdateFromInput);
  els.updateText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addUpdateFromInput(); }
  });

  if (els.loadIncidentBtn && els.incidentSelect) {
    els.loadIncidentBtn.addEventListener('click', () => {
      const id = els.incidentSelect.value;
      if (id) useIncident(id);
    });
    els.incidentSelect.addEventListener('change', () => {
      const id = els.incidentSelect.value;
      if (id) useIncident(id);
    });
  }

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    els.plan.setAttribute('aria-busy', 'true');
    const payload = readForm();
    try {
      await requestPlanFromApi(payload);
    } catch (err) {
      console.error(err);
      alert('Failed to generate plan. Falling back to local template.');
      renderPlan(generatePlanFromTemplate(payload));
    } finally {
      els.plan.setAttribute('aria-busy', 'false');
    }
  });

  // Live re-plan on form edits
  ;['disaster-type','location','population','resources','constraints','details'].forEach(id => {
    const el = byId(id);
    if (el) el.addEventListener('input', recomputePlan);
  });

  els.reset.addEventListener('click', () => {
    els.form.reset();
    // Do not remove crowd updates on main page reset
    els.plan.innerHTML = '';
    els.empty.style.display = '';
    state.lastPlan = null;
  });

  els.copy.addEventListener('click', async () => {
    if (!state.lastPlan) { alert('No plan to copy yet.'); return; }
    const text = planToText(state.lastPlan);
    try {
      await navigator.clipboard.writeText(text);
      els.copy.textContent = 'Copied!';
      setTimeout(() => (els.copy.textContent = 'Copy Plan'), 1200);
    } catch {
      // Fallback: open a new window with text
      const w = window.open('', '_blank');
      w.document.write(`<pre>${text.replace(/[&<>]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[s]))}</pre>`);
      w.document.close();
    }
  });

  els.export.addEventListener('click', () => {
    if (!state.lastPlan) { alert('No plan to export yet.'); return; }
    const blob = new Blob([JSON.stringify(state.lastPlan, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rescuemind-plan-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  if (els.locateMe) {
    els.locateMe.addEventListener('click', async () => {
      const ok = await locateMe();
      if (!ok) await ipLocate();
    });
  }
  if (els.locateIp) {
    els.locateIp.addEventListener('click', ipLocate);
  }
  if (els.nearbyOnly) {
    els.nearbyOnly.addEventListener('change', () => { renderDisasters(); plotMarkers(); });
  }
  if (els.incidentSearch) {
    els.incidentSearch.addEventListener('input', () => {
      state.searchQuery = (els.incidentSearch.value || '').trim();
      renderDisasters();
      plotMarkers();
    });
  }
  // Removed AI UI controls; always use local generator by default
  if (els.shareLink) {
    els.shareLink.addEventListener('click', () => {
      const id = state.currentIncidentId || '';
      const url = new URL(location.href);
      url.hash = id ? `#incident/${id}` : '';
      url.searchParams.delete('ai');
      const link = url.toString();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link)
          .then(() => {
            els.shareLink.textContent = 'Link Copied!';
            setTimeout(() => (els.shareLink.textContent = 'Share Link'), 1200);
          })
          .catch(() => {
            window.prompt('Copy this link:', link);
          });
      } else {
        window.prompt('Copy this link:', link);
      }
    });
  }
  if (els.printPlan) {
    els.printPlan.addEventListener('click', () => {
      if (!state.lastPlan || !els.plan || !els.plan.innerHTML.trim()) {
        alert('No plan to print yet. Generate a plan first.');
        return;
      }
      // Use native print with print CSS to avoid opening new tabs/windows
      try { window.print(); } catch(_) {}
    });
  }

  // New Incident (main page)
  if (els.newIncident && els.newIncident.useLoc) {
    els.newIncident.useLoc.addEventListener('click', async () => {
      await locateMe();
      if (state.userLocation) {
        els.newIncident.lat.value = state.userLocation.lat.toFixed(6);
        els.newIncident.lng.value = state.userLocation.lng.toFixed(6);
      }
    });
  }
  if (els.newIncident && els.newIncident.add) {
    els.newIncident.add.addEventListener('click', () => {
      const name = sanitize(els.newIncident.name.value);
      const type = sanitize(els.newIncident.type.value) || 'Other';
      const lat = Number(els.newIncident.lat.value);
      const lng = Number(els.newIncident.lng.value);
      if (!name) { alert('Please provide a name'); return; }
      if (name.length > 80) { alert('Name too long (max 80 characters).'); return; }
      if (!lat || !lng) { alert('Please provide valid coordinates'); return; }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) { alert('Coordinates out of range'); return; }
      const id = `${type.toLowerCase()}-${Date.now()}`;
      const inc = {
        id,
        name,
        type,
        status: 'ongoing',
        lat, lng,
        population: 0,
        resources: '',
        constraints: '',
        details: '',
        createdAt: nowIso(),
        updates: [],
      };
      state.disasters.push(inc);
      renderDisasters();
      plotMarkers();
      useIncident(id);
      const detailsEl = document.getElementById('new-incident');
      if (detailsEl && detailsEl.open) detailsEl.open = false;
    });
  }

  // Initialize
  loadDisasters();
  window.addEventListener('hashchange', handleHash);
  handleHash();
  window.addEventListener('load', ensureMap);
  window.addEventListener('resize', () => state.map && state.map.invalidateSize());

  // Attempt to prefill new-incident coordinates using geolocation
  (async () => {
    const ok = await locateBestEffort();
    if (ok && els.newIncident && els.newIncident.lat && els.newIncident.lng && state.userLocation) {
      els.newIncident.lat.value = state.userLocation.lat.toFixed(6);
      els.newIncident.lng.value = state.userLocation.lng.toFixed(6);
    }
  })();

  

  // Removed auto-enable AI from URL param; AI UI removed

  // WebSocket client stub (optional)
  const WS_CONFIG = { enabled: false, url: '' };
  let ws = null; let wsTimer = null;
  function wsConnect() {
    if (!WS_CONFIG.enabled || !WS_CONFIG.url) return;
    try {
      ws = new WebSocket(WS_CONFIG.url);
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'hello', id: state.clientId }));
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.from === state.clientId) return;
          if (msg.t === 'select') {
            if (!state.currentIncidentId) useIncident(msg.id);
          }
          if (msg.t === 'update' && msg.id === state.currentIncidentId) {
            const exists = state.updates.some(u => u.text === msg.update.text && u.ts === msg.update.ts);
            if (!exists) {
              state.updates.push({ text: msg.update.text, ts: msg.update.ts, resolved: !!msg.update.resolved });
              renderUpdates();
              recomputePlan();
            }
          }
        } catch (_) {}
      };
      ws.onclose = () => { ws = null; wsTimer = setTimeout(wsConnect, 3000); };
      ws.onerror = () => { try { ws && ws.close(); } catch(_) {}; };
    } catch (_) {}
  }
  wsConnect();

  // Cross-tab collaboration via BroadcastChannel
  try {
    if ('BroadcastChannel' in window) {
      state.bc = new BroadcastChannel('rescuemind');
      state.bc.onmessage = (evt) => {
        const msg = evt.data || {};
        if (msg.from === state.clientId) return; // ignore self
        if (msg.t === 'select') {
          // If no incident selected, follow selection
          if (!state.currentIncidentId) useIncident(msg.id);
        }
        if (msg.t === 'update' && msg.id === state.currentIncidentId) {
          // Deduplicate by text+ts combo
          const exists = state.updates.some(u => u.text === msg.update.text && u.ts === msg.update.ts);
          if (!exists) {
            state.updates.push({ text: msg.update.text, ts: msg.update.ts, resolved: !!msg.update.resolved });
            renderUpdates();
            recomputePlan();
          }
        }
        if (msg.t === 'update_resolve' && msg.id === state.currentIncidentId) {
          const u = state.updates.find(u => u.text === msg.update.text && u.ts === msg.update.ts);
          if (u) {
            u.resolved = !!msg.update.resolved;
            renderUpdates();
            recomputePlan();
          }
        }
        if (msg.t === 'update_delete' && msg.id === state.currentIncidentId) {
          const i = state.updates.findIndex(u => u.text === msg.update.text && u.ts === msg.update.ts);
          if (i >= 0) {
            state.updates.splice(i, 1);
            renderUpdates();
            recomputePlan();
          }
        }
      };
    }
  } catch (_) {}
})();
