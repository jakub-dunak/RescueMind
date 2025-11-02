(() => {
  'use strict';

  console.log('[Authority] Script loaded');

  const els = {
    form: document.getElementById('incident-form'),
    id: document.getElementById('id'),
    name: document.getElementById('name'),
    type: document.getElementById('type'),
    status: document.getElementById('status'),
    lat: document.getElementById('lat'),
    lng: document.getElementById('lng'),
    useGeo: document.getElementById('auth-use-geo'),
    useIp: document.getElementById('auth-use-ip'),
    coordHint: document.getElementById('coord-hint'),
    add: document.getElementById('add-incident'),
    update: document.getElementById('update-incident'),
    list: document.getElementById('dataset-list'),
    connectFolder: document.getElementById('connect-folder'),
    folderHint: document.getElementById('folder-hint'),
    editHint: document.getElementById('edit-hint'),
    authUpdatesList: document.getElementById('auth-updates-list'),
    authUpdateText: document.getElementById('auth-update-text'),
    authAddUpdate: document.getElementById('auth-add-update'),
    authToken: document.getElementById('auth-token'),
  };

  const state = {
    dataset: { incidents: [] },
    lockId: false,
    dirHandle: null,
    editingId: null,
    bc: null,
  };

  function sanitize(s) { return String(s ?? '').trim(); }
  function nowIso() { return new Date().toISOString(); }
  function slug(s) {
    return sanitize(s).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'incident';
  }

  function autoId() {
    if (state.lockId) return els.id?.value;
    const type = sanitize(els.type?.value || 'incident').toLowerCase();
    const name = slug(els.name?.value || '');
    const id = `${type}-${name}-${Date.now()}`;
    if (els.id) els.id.value = id;
    return id;
  }

  async function locateMe() {
    if (!('geolocation' in navigator)) return false;
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition((pos) => {
        const lat = pos.coords.latitude, lng = pos.coords.longitude;
        if (els.lat) els.lat.value = lat.toFixed(6);
        if (els.lng) els.lng.value = lng.toFixed(6);
        if (els.coordHint) els.coordHint.textContent = 'Coordinates set from device location';
        resolve(true);
      }, (err) => {
        if (els.coordHint) els.coordHint.textContent = 'Geolocation denied/unavailable';
        resolve(false);
      }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
    });
  }

  async function ipLocate() {
    try {
      let res = await fetch('https://ipapi.co/json/');
      if (res.ok) {
        const d = await res.json();
        if (typeof d.latitude === 'number' && typeof d.longitude === 'number') {
          if (els.lat) els.lat.value = d.latitude.toFixed(6);
          if (els.lng) els.lng.value = d.longitude.toFixed(6);
          if (els.coordHint) els.coordHint.textContent = 'Coordinates set from IP location';
          return true;
        }
      }
      res = await fetch('https://get.geojs.io/v1/ip/geo.json');
      if (res.ok) {
        const g = await res.json();
        const lat = parseFloat(g.latitude), lng = parseFloat(g.longitude);
        if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
          if (els.lat) els.lat.value = lat.toFixed(6);
          if (els.lng) els.lng.value = lng.toFixed(6);
          if (els.coordHint) els.coordHint.textContent = 'Coordinates set from IP location';
          return true;
        }
      }
    } catch (_) { /* ignore */ }
    if (els.coordHint) els.coordHint.textContent = 'Unable to auto-detect coordinates';
    return false;
  }

  async function locateBestEffort() {
    console.log('[Authority] Attempting geolocation…');
    let ok = await locateMe();
    console.log('[Authority] Geolocation result:', ok);
    if (!ok) {
      console.log('[Authority] Attempting IP location…');
      ok = await ipLocate();
      console.log('[Authority] IP location result:', ok);
    }
    return ok;
  }

  function readForm() {
    const f = new FormData(els.form);
    const id = sanitize(f.get('id')) || autoId();
    return {
      id,
      name: sanitize(f.get('name')),
      type: sanitize(f.get('type')) || 'Other',
      status: sanitize(f.get('status')) || 'ongoing',
      lat: Number(f.get('lat') || 0),
      lng: Number(f.get('lng') || 0),
      population: Number(f.get('population') || 0),
      resources: sanitize(f.get('resources')),
      constraints: sanitize(f.get('constraints')),
      details: sanitize(f.get('details')),
      createdAt: nowIso(),
      updates: [],
    };
  }

  function renderList() {
    els.list.innerHTML = '';
    const has = state.dataset.incidents.length > 0;
    els.list.classList.toggle('has-items', has);
    state.dataset.incidents.forEach((inc, idx) => {
      const li = document.createElement('li');
      li.classList.add('clickable');
      const left = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'incident-title';
      title.textContent = `${inc.name} (${inc.type})`;
      const meta = document.createElement('div');
      meta.className = 'incident-meta';
      meta.textContent = `${inc.status} · ${inc.population} affected · ${inc.lat.toFixed(4)}, ${inc.lng.toFixed(4)}`;
      left.appendChild(title);
      left.appendChild(meta);
      // Clicking on the row (except on buttons) loads the incident
      li.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        loadIntoForm(inc);
      });
      const del = document.createElement('button');
      del.className = 'btn';
      del.textContent = 'Delete…';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDeleteConfirm(li, idx);
      });
      const loadBtn = document.createElement('button');
      loadBtn.className = 'btn secondary';
      loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', (e) => { e.stopPropagation(); loadIntoForm(inc); });
      const actions = document.createElement('div');
      actions.style.display = 'inline-flex';
      actions.style.gap = '8px';
      actions.appendChild(loadBtn);
      actions.appendChild(del);
      li.appendChild(left);
      li.appendChild(actions);
      els.list.appendChild(li);
    });
  }

  function toggleDeleteConfirm(li, idx) {
    let box = li.querySelector('.confirm-delete');
    if (box) { box.remove(); return; }
    box = document.createElement('span');
    box.className = 'confirm-delete';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.id = `confirm-del-${idx}`;
    const lab = document.createElement('label');
    lab.setAttribute('for', cb.id);
    lab.textContent = 'Confirm delete';
    const ok = document.createElement('button');
    ok.className = 'btn danger'; ok.textContent = 'Confirm'; ok.disabled = true;
    ok.addEventListener('click', async (e) => {
      e.stopPropagation();
      const inc = state.dataset.incidents[idx];
      // Remove from in-memory list
      state.dataset.incidents.splice(idx, 1);
      renderList();

      // Try to delete from API first
      const base = (window.__DATA_BASE__ || '').replace(/\/$/, '');
      const token = window.__AUTH_TOKEN__;
      if (base && token) {
        try {
          const url = `${base}/api/incidents/${inc.id}`;
          const response = await fetch(url, {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${token}`
            }
          });
          if (response.ok) {
            console.log('[Authority] Incident deleted from API:', inc.id);
            if (els.folderHint) els.folderHint.textContent = 'Deleted from server';
            return; // Successfully deleted from API, no need for local filesystem operations
          } else {
            console.warn('[Authority] Failed to delete from API:', response.status);
          }
        } catch (err) {
          console.warn('[Authority] API delete failed:', err);
        }
      }

      // Fallback: If a folder is connected, attempt to remove the file and update manifest
      if (state.dirHandle) {
        try {
          const fileName = inc && inc.file ? inc.file : `${inc.id}.json`;
          // Delete incident file
          await state.dirHandle.removeEntry(fileName);
          // Update index.json manifest
          const idxHandle = await state.dirHandle.getFileHandle('index.json');
          const idxFile = await idxHandle.getFile();
          const text = await idxFile.text();
          const manifest = JSON.parse(text);
          manifest.incidents = (manifest.incidents || []).filter(x => x.file !== fileName);
          const writable = await idxHandle.createWritable();
          await writable.write(JSON.stringify(manifest, null, 2));
          await writable.close();
          if (els.folderHint) els.folderHint.textContent = 'Deleted file and updated index.json';
        } catch (err) {
          console.warn('Filesystem delete failed', err);
          if (els.folderHint) els.folderHint.textContent = 'Deleted in list. Connect folder to delete files.';
        }
      }
    });
    const cancel = document.createElement('button');
    cancel.className = 'btn'; cancel.textContent = 'Cancel';
    cancel.addEventListener('click', (e) => { e.stopPropagation(); box.remove(); });
    cb.addEventListener('change', () => { ok.disabled = !cb.checked; });
    box.appendChild(cb); box.appendChild(lab); box.appendChild(ok); box.appendChild(cancel);
    li.appendChild(box);
  }

  async function connectIncidentFolder() {
    try {
      if (!window.showDirectoryPicker) {
        alert('Your browser does not support local folder access.');
        return;
      }
      const dir = await window.showDirectoryPicker();
      // Validate index.json exists
      await dir.getFileHandle('index.json');
      state.dirHandle = dir;
      if (els.folderHint) els.folderHint.textContent = 'Incident folder connected.';
    } catch (e) {
      console.warn(e);
      if (els.folderHint) els.folderHint.textContent = 'Failed to connect folder.';
    }
  }

  function loadIntoForm(inc) {
    if (!inc) return;
    state.lockId = true;
    state.editingId = inc.id;
    if (els.id) els.id.value = inc.id;
    if (els.name) els.name.value = inc.name || '';
    if (els.type) els.type.value = inc.type || 'Other';
    if (els.status) els.status.value = inc.status || 'ongoing';
    if (els.lat) els.lat.value = (inc.lat ?? '').toString();
    if (els.lng) els.lng.value = (inc.lng ?? '').toString();
    const pop = document.getElementById('population');
    if (pop) pop.value = (inc.population ?? 0).toString();
    const res = document.getElementById('resources');
    if (res) res.value = inc.resources || '';
    const con = document.getElementById('constraints');
    if (con) con.value = inc.constraints || '';
    const det = document.getElementById('details');
    if (det) det.value = inc.details || '';
    if (els.coordHint) els.coordHint.textContent = 'Loaded from dataset';
    if (els.update) els.update.disabled = false;
    if (els.editHint) els.editHint.textContent = `Editing ${inc.id}`;
    renderAuthorityUpdates();
  }

  function updateIncident() {
    if (!state.editingId) { alert('No incident loaded to update.'); return; }
    const idx = state.dataset.incidents.findIndex(x => x.id === state.editingId);
    if (idx === -1) { alert('Loaded incident not found in dataset.'); return; }
    const existing = state.dataset.incidents[idx];
    const f = new FormData(els.form);
    const updated = {
      id: existing.id,
      name: sanitize(f.get('name')),
      type: sanitize(f.get('type')) || existing.type,
      status: sanitize(f.get('status')) || existing.status,
      lat: Number(f.get('lat') || existing.lat || 0),
      lng: Number(f.get('lng') || existing.lng || 0),
      population: Number(f.get('population') || existing.population || 0),
      resources: sanitize(f.get('resources')),
      constraints: sanitize(f.get('constraints')),
      details: sanitize(f.get('details')),
      createdAt: existing.createdAt,
      updates: existing.updates || [],
      file: existing.file,
    };
    if (!updated.name) { alert('Please provide a Name'); return; }
    if (updated.name.length > 80) { alert('Name too long (max 80 characters).'); return; }
    if (updated.lat < -90 || updated.lat > 90 || updated.lng < -180 || updated.lng > 180) { alert('Coordinates out of range'); return; }
    state.dataset.incidents[idx] = updated;
    renderList();
    if (els.editHint) { els.editHint.textContent = 'Incident updated'; setTimeout(() => els.editHint.textContent = `Editing ${updated.id}`, 1200); }
    renderAuthorityUpdates();
  }

function renderAuthorityUpdates() {
    if (!els.authUpdatesList) return;
    const inc = state.dataset.incidents.find(x => x.id === state.editingId);
    els.authUpdatesList.innerHTML = '';
    if (!inc || !Array.isArray(inc.updates)) {
      const li = document.createElement('li');
      li.textContent = 'No updates loaded. Select an incident.';
      els.authUpdatesList.appendChild(li);
      return;
    }
    const items = [...inc.updates].sort((a, b) => {
      const ra = a.resolved ? 1 : 0;
      const rb = b.resolved ? 1 : 0;
      if (ra !== rb) return ra - rb; // unresolved first
      const ta = Date.parse(a.ts || '') || 0;
      const tb = Date.parse(b.ts || '') || 0;
      return ta - tb;
    });
    if (!items.length) {
      const li = document.createElement('li');
      li.textContent = 'No updates yet for this incident.';
      els.authUpdatesList.appendChild(li);
      return;
    }
    items.forEach((u, idx) => {
      const li = document.createElement('li');
      const text = document.createElement('div');
      text.textContent = u.text;
      const meta = document.createElement('time');
      meta.className = 'meta';
      meta.dateTime = u.ts;
      meta.textContent = new Date(u.ts).toLocaleString();
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = u.resolved ? 'Resolved' : 'Open';
      const actions = document.createElement('div');
      actions.style.display = 'inline-flex';
      actions.style.gap = '8px';
      const toggle = document.createElement('button');
      toggle.className = 'btn';
      toggle.textContent = u.resolved ? 'Unresolve' : 'Resolve';
      toggle.addEventListener('click', () => {
        u.resolved = !u.resolved;
        if (els.editHint) els.editHint.textContent = u.resolved ? 'Update resolved' : 'Update reopened';
        // Broadcast resolve/unresolve to main page
        try {
          if (state.bc && state.editingId) {
            state.bc.postMessage({ t: 'update_resolve', id: state.editingId, update: { text: u.text, ts: u.ts, resolved: !!u.resolved }, from: 'authority' });
          }
        } catch (_) {}
        // Persist changes to incident file
        persistIncident(inc);
        renderAuthorityUpdates();
      });
      const del = document.createElement('button');
      del.className = 'btn danger';
      del.textContent = 'Delete';
      del.addEventListener('click', () => {
        if (!confirm('Delete this update?')) return;
        const i = inc.updates.indexOf(u);
        if (i >= 0) inc.updates.splice(i, 1);
        if (els.editHint) els.editHint.textContent = 'Update deleted';
        // Broadcast delete to main page
        try {
          if (state.bc && state.editingId) {
            state.bc.postMessage({ t: 'update_delete', id: state.editingId, update: { text: u.text, ts: u.ts }, from: 'authority' });
          }
        } catch (_) {}
        // Persist changes to incident file
        persistIncident(inc);
        renderAuthorityUpdates();
      });
      li.appendChild(text);
      const right = document.createElement('div');
      right.style.display = 'grid';
      right.style.gap = '6px';
      right.appendChild(meta);
      right.appendChild(badge);
      actions.appendChild(toggle);
      actions.appendChild(del);
      right.appendChild(actions);
      li.appendChild(right);
      els.authUpdatesList.appendChild(li);
    });
  }

  // (removed duplicate simplified renderAuthorityUpdates; using full-featured version above)

  // legacy loader removed; using manifest-based loader

  // Load auth token from API (protected by Cloudflare Access)
  async function loadAuthToken() {
    const base = (window.__DATA_BASE__ || '').replace(/\/$/, '');
    if (!base) return;

    try {
      const response = await fetch(`${base}/api/auth-token`);
      if (response.ok) {
        const data = await response.json();
        window.__AUTH_TOKEN__ = data.token;
        console.log('[Authority] Auth token loaded successfully');
        // Update UI to show token is available
        if (els.authToken) {
          els.authToken.value = '••••••••'; // Show masked token
          els.authToken.disabled = true;
          els.authToken.placeholder = 'Token loaded automatically';
        }
      } else {
        console.warn('[Authority] Could not load auth token:', response.status);
        // Leave manual input enabled
      }
    } catch (error) {
      console.warn('[Authority] Failed to load auth token:', error);
      // Leave manual input enabled
    }
  }

  // Auto-load all incidents from data/incidents/index.json
  async function loadFromManifest() {
    try {
      const base = (window.__DATA_BASE__ || '').replace(/\/$/, '');
      const idxUrl = base ? `${base}/data/incidents/index.json` : 'data/incidents/index.json';
      console.log('[Authority] Loading incidents from:', idxUrl);
      const res = await fetch(idxUrl, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`Failed to load manifest: ${res.status} ${res.statusText}`);
      const manifest = await res.json();
      console.log('[Authority] Successfully loaded manifest with', manifest.incidents?.length || 0, 'incidents');
      const items = Array.isArray(manifest.incidents) ? manifest.incidents : [];
      const incidents = await Promise.all(items.map(async (it) => {
        const fileUrl = base ? `${base}/data/incidents/${it.file}` : `data/incidents/${it.file}`;
        const r = await fetch(fileUrl, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`Failed to load ${it.file}`);
        const data = await r.json();
        return { ...data, file: it.file };
      }));
      state.dataset = { incidents };
      renderList();
      // Auto-load the first incident to show updates immediately
      if (!state.editingId && state.dataset.incidents.length) {
        loadIntoForm(state.dataset.incidents[0]);
      }
    } catch (e) {
      console.warn('[Authority] Failed to load from API, falling back to offline mode:', e.message);
      console.log('[Authority] Using offline/local data mode');
      // Fallback to legacy disasters.json if present
      try {
        const base = (window.__DATA_BASE__ || '').replace(/\/$/, '');
        const legacyUrl = base ? `${base}/data/disasters.json` : 'data/disasters.json';
        console.log('[Authority] Trying legacy disasters.json:', legacyUrl);
        const legacy = await fetch(legacyUrl, { cache: 'no-cache' });
        if (legacy.ok) {
          const data = await legacy.json();
          state.dataset = { incidents: Array.isArray(data.incidents) ? data.incidents : [] };
          console.log('[Authority] Loaded', state.dataset.incidents.length, 'incidents from legacy file');
          renderList();
          if (!state.editingId && state.dataset.incidents.length) {
            loadIntoForm(state.dataset.incidents[0]);
          }
        } else {
          console.log('[Authority] Legacy file not found, starting with empty dataset');
        }
      } catch (fallbackError) {
        console.warn('[Authority] Legacy fallback also failed:', fallbackError.message);
        console.log('[Authority] Starting with empty offline dataset');
      }
    }
  }

  els.add.addEventListener('click', () => {
    const inc = readForm();
    if (!inc.name) { alert('Please provide a Name'); return; }
    if (!inc.lat || !inc.lng) { alert('Please provide Latitude and Longitude'); return; }
    // Ensure unique id
    if (state.dataset.incidents.some(x => x.id === inc.id)) {
      alert('ID already exists — please choose a unique ID');
      return;
    }
    state.dataset.incidents.push(inc);
    renderList();
    // Reset editing state since this is a new addition
    state.editingId = inc.id;
    if (els.update) els.update.disabled = false;
    if (els.editHint) els.editHint.textContent = `Editing ${inc.id}`;
    // Persist new incident to connected folder
    persistIncident(inc);
  });

  // Auto-load auth token and incidents on page load
  loadAuthToken().then(() => loadFromManifest());

  // Initialize ID and coordinates on load
  autoId();
  if (els.coordHint) els.coordHint.textContent = 'Detecting coordinates…';
  locateBestEffort().then((ok) => {
    if (!ok && els.coordHint) els.coordHint.textContent = 'Unable to auto-detect coordinates';
  });

  // Keep ID updated when name/type changes (read-only input, programmatic updates)
  if (els.name) els.name.addEventListener('input', autoId);
  if (els.type) els.type.addEventListener('change', autoId);
  if (els.useGeo) els.useGeo.addEventListener('click', locateMe);
  if (els.useIp) els.useIp.addEventListener('click', ipLocate);
  if (els.connectFolder) els.connectFolder.addEventListener('click', connectIncidentFolder);
  if (els.update) els.update.addEventListener('click', updateIncident);
  if (els.authAddUpdate && els.authUpdateText) {
    const addFn = () => {
      const inc = state.dataset.incidents.find(x => x.id === state.editingId);
      if (!inc) return;
      const t = String(els.authUpdateText.value || '').trim();
      if (!t) return;
      const upd = { text: t, ts: nowIso() };
      (inc.updates || (inc.updates = [])).push(upd);
      els.authUpdateText.value = '';
      // Broadcast new update to main page (resolved defaults to false)
      try {
        if (state.bc && state.editingId) {
          state.bc.postMessage({ t: 'update', id: state.editingId, update: { ...upd, resolved: false }, from: 'authority' });
        }
      } catch (_) {}
      // Persist update addition
      persistIncident(inc);
      renderAuthorityUpdates();
    };
    els.authAddUpdate.addEventListener('click', addFn);
    els.authUpdateText.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addFn(); } });
  }

  // Clear editing state on form reset
  if (els.form) els.form.addEventListener('reset', () => {
    state.editingId = null;
    state.lockId = false;
    if (els.update) els.update.disabled = true;
    if (els.editHint) els.editHint.textContent = '';
    if (els.authUpdatesList) els.authUpdatesList.innerHTML = '';
  });

  // Persist incident to API
  async function persistIncident(incident) {
    const base = (window.__DATA_BASE__ || '').replace(/\/$/, '');
    const token = window.__AUTH_TOKEN__;

    if (!base) {
      console.warn('[Authority] No __DATA_BASE__ configured, cannot persist incident');
      alert('API endpoint not configured. Please check __DATA_BASE__ setting.');
      return;
    }

    if (!token) {
      console.warn('[Authority] No __AUTH_TOKEN__ configured, cannot persist incident');
      alert('Authorization token not available. Please ensure you have access to the authority console through Cloudflare Access.');
      return;
    }

    try {
      const url = `${base}/api/incidents/${incident.id}`;
      console.log('[Authority] Persisting incident to:', url);

      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(incident)
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`HTTP ${response.status}: ${error}`);
      }

      const result = await response.json();
      console.log('[Authority] Incident persisted successfully:', result);
    } catch (error) {
      console.error('[Authority] Failed to persist incident:', error);
      // Could show user notification here
    }
  }

  // Initialize BroadcastChannel for cross-tab signals
  try {
    if ('BroadcastChannel' in window) {
      state.bc = new BroadcastChannel('rescuemind');
    }
  } catch (_) {}

})();
