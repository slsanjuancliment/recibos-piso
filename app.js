// Recibos piso — PWA que guarda fotos de comprobantes en Google Drive.
const CFG = window.RECIBOS_CONFIG || {};
const TIPOS = CFG.TIPOS?.length ? CFG.TIPOS : ["Alquiler", "Luz", "Otro"];
const ROOT_FOLDER = CFG.ROOT_FOLDER || "Recibos piso";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const APP_TAG = "recibos-piso";
const ICONS = { Alquiler: "🏠", Luz: "💡", Agua: "🚿", Gas: "🔥", Otro: "🧾" };

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// ---------- Utilidades ----------
const pad = (n) => String(n).padStart(2, "0");
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const monthISO = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const monthLabel = (p, opts = { month: "long", year: "numeric" }) => {
  const [y, m] = p.split("-").map(Number);
  const s = new Date(y, m - 1, 1).toLocaleDateString("es-ES", opts);
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const dateLabel = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });
};
const parseAmount = (s) => {
  if (!s) return "";
  const clean = s.replace(/[€\s]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = Number(clean);
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : "";
};
const fmtAmount = (a) => a ? Number(a).toLocaleString("es-ES", { style: "currency", currency: "EUR" }) : "";
const escQ = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

// ---------- Autenticación (OAuth implícito por redirección: funciona en la app instalada de iOS) ----------
class AuthError extends Error {}
const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, "");

function getToken() {
  const t = store.get("token");
  return t && t.exp > Date.now() + 60_000 ? t.value : null;
}

function login(forceConsent = false) {
  const state = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
  store.set("oauth_state", state);
  const p = new URLSearchParams({
    client_id: CFG.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "token",
    scope: SCOPE,
    include_granted_scopes: "true",
    state,
  });
  const user = store.get("user");
  if (user?.email && !forceConsent) p.set("login_hint", user.email);
  if (forceConsent) p.set("prompt", "consent select_account");
  location.href = "https://accounts.google.com/o/oauth2/v2/auth?" + p;
}

function handleOAuthRedirect() {
  if (!location.hash.includes("access_token") && !location.hash.includes("error=")) return;
  const h = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", redirectUri());
  if (h.get("error")) { toast("No se pudo conectar con Google: " + h.get("error")); return; }
  if (h.get("state") !== store.get("oauth_state")) { toast("Respuesta de Google no válida, prueba otra vez."); return; }
  store.del("oauth_state");
  store.set("token", { value: h.get("access_token"), exp: Date.now() + Number(h.get("expires_in") || 3600) * 1000 });
}

function logout() {
  const t = store.get("token");
  if (t?.value) fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(t.value), { method: "POST" }).catch(() => {});
  ["token", "user", "files"].forEach(store.del);
  render();
}

async function api(url, opts = {}) {
  const token = getToken();
  if (!token) throw new AuthError();
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + token } });
  if (r.status === 401) { store.del("token"); throw new AuthError(); }
  if (!r.ok) {
    let msg = r.status + "";
    try { msg = (await r.json()).error?.message || msg; } catch {}
    throw new Error(msg);
  }
  return r;
}

// ---------- Google Drive ----------
const folderCache = new Map();
async function folder(name, parentId = "root") {
  const key = parentId + "/" + name;
  if (folderCache.has(key)) return folderCache.get(key);
  const q = `name='${escQ(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${parentId}' in parents`;
  const r = await api(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`);
  let id = (await r.json()).files?.[0]?.id;
  if (!id) {
    const c = await api(`${DRIVE}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
    });
    id = (await c.json()).id;
  }
  folderCache.set(key, id);
  return id;
}

async function uploadReceipt({ blob, meta }) {
  const year = meta.periodo.slice(0, 4);
  const root = await folder(ROOT_FOLDER);
  const yearId = await folder(year, root);
  const tipoId = await folder(meta.tipo, yearId);
  const name = `${meta.periodo} ${meta.tipo}${meta.importe ? " - " + fmtAmount(meta.importe).replace(/ /g, " ") : ""}.jpg`;
  const description = [
    `${meta.tipo} · ${monthLabel(meta.periodo)}`,
    `Ingreso en cajero: ${dateLabel(meta.fechaPago)}`,
    meta.importe ? `Importe: ${fmtAmount(meta.importe)}` : "",
    meta.nota ? `Nota: ${meta.nota}` : "",
  ].filter(Boolean).join("\n");
  const metadata = {
    name,
    mimeType: "image/jpeg",
    parents: [tipoId],
    description,
    appProperties: { app: APP_TAG, tipo: meta.tipo, periodo: meta.periodo, fechaPago: meta.fechaPago, importe: meta.importe || "" },
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", blob, name);
  const r = await api(`${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`, { method: "POST", body: form });
  return r.json();
}

const FILE_FIELDS = "id,name,description,appProperties,createdTime,webViewLink";
async function listReceipts() {
  const q = `appProperties has { key='app' and value='${APP_TAG}' } and trashed=false`;
  let files = [], pageToken = "";
  do {
    const r = await api(`${DRIVE}/files?q=${encodeURIComponent(q)}&pageSize=1000&spaces=drive&fields=nextPageToken,files(${FILE_FIELDS})${pageToken ? "&pageToken=" + pageToken : ""}`);
    const j = await r.json();
    files = files.concat(j.files || []);
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return files;
}

async function loadUser() {
  const r = await api(`${DRIVE}/about?fields=user(emailAddress,displayName)`);
  const u = (await r.json()).user || {};
  store.set("user", { email: u.emailAddress, name: u.displayName });
}

// ---------- Cola local (IndexedDB): nada se pierde si falla la subida ----------
const idb = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const req = indexedDB.open("recibos", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("queue", { keyPath: "id" });
      req.onsuccess = () => res(this.db = req.result);
      req.onerror = () => rej(req.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction("queue", mode);
      const out = fn(t.objectStore("queue"));
      t.oncomplete = () => res(out?.result ?? out);
      t.onerror = () => rej(t.error);
    });
  },
  put(item) { return this.tx("readwrite", (s) => s.put(item)); },
  del(id) { return this.tx("readwrite", (s) => s.delete(id)); },
  all() { return this.tx("readonly", (s) => s.getAll()); },
};

let processing = false;
async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    const items = await idb.all();
    for (const item of items.sort((a, b) => a.createdAt - b.createdAt)) {
      const file = await uploadReceipt(item);
      await idb.del(item.id);
      const files = store.get("files", []);
      files.push(file);
      store.set("files", files);
      toast("✓ Guardado en Drive: " + file.name);
    }
  } catch (e) {
    if (e instanceof AuthError) { await renderPending(); login(); return; }
    toast("No se pudo subir (se reintentará): " + e.message, 4000);
  } finally {
    processing = false;
    await renderPending();
    renderFiles();
  }
}

// ---------- Imagen: reducir tamaño y opcionalmente realzar el ticket ----------
async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function processImage(img, enhance) {
  const MAX = 2400;
  const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: enhance });
  ctx.drawImage(img, 0, 0, w, h);
  if (enhance) {
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data, hist = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 4) {
      const l = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 | 0;
      px[i] = l; hist[l]++;
    }
    const total = w * h; let acc = 0, lo = 0, hi = 255;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > total * 0.01) { lo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > total * 0.05) { hi = i; break; } }
    const range = Math.max(1, hi - lo);
    for (let i = 0; i < px.length; i += 4) {
      let v = (px[i] - lo) / range;
      v = Math.min(1, Math.max(0, v));
      v = Math.pow(v, 1.6) * 255; // oscurece el texto descolorido
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    ctx.putImageData(data, 0, 0);
  }
  return new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
}

// ---------- Formulario ----------
let currentImg = null, currentTipo = TIPOS[0], previewUrl = null;

function buildTipoButtons() {
  const g = $("tipoGroup");
  g.innerHTML = "";
  for (const t of TIPOS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `${ICONS[t] || "🧾"} ${t}`;
    b.setAttribute("aria-pressed", String(t === currentTipo));
    b.onclick = () => { currentTipo = t; buildTipoButtons(); };
    g.appendChild(b);
  }
}

let previewSeq = 0;
async function refreshPreview() {
  if (!currentImg) return;
  const seq = ++previewSeq;
  const blob = await processImage(currentImg, $("enhance").checked);
  if (seq !== previewSeq) return;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  $("preview").src = previewUrl;
}

async function onFilePicked(e) {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    currentImg = await loadImage(file);
  } catch {
    toast("No se pudo leer la imagen");
    return;
  }
  $("periodo").value = monthISO();
  $("fechaPago").value = todayISO();
  $("importe").value = "";
  $("nota").value = "";
  $("enhance").checked = false;
  buildTipoButtons();
  $("saveBtn").disabled = false;
  $("formDialog").showModal();
  refreshPreview();
}

async function onSave(e) {
  e.preventDefault();
  if (!currentImg) return;
  $("saveBtn").disabled = true;
  try {
    const blob = await processImage(currentImg, $("enhance").checked);
    const item = {
      id: Date.now() + "-" + Math.random().toString(36).slice(2),
      createdAt: Date.now(),
      blob,
      meta: {
        tipo: currentTipo,
        periodo: $("periodo").value || monthISO(),
        fechaPago: $("fechaPago").value || todayISO(),
        importe: parseAmount($("importe").value),
        nota: $("nota").value.trim(),
      },
    };
    await idb.put(item); // primero se guarda en el móvil, luego se sube
    $("formDialog").close();
    currentImg = null;
    toast("Subiendo a Drive…");
    await renderPending();
    processQueue();
  } catch (err) {
    toast("Error al guardar: " + err.message, 4000);
    $("saveBtn").disabled = false;
  }
}

// ---------- Visor ----------
let viewerUrl = null, viewerFile = null;
async function openViewer(file) {
  viewerFile = file;
  const p = file.appProperties || {};
  $("viewerImg").removeAttribute("src");
  $("viewerLoading").hidden = false;
  $("driveLink").href = file.webViewLink || "#";
  $("viewerInfo").innerHTML = "";
  const dl = document.createElement("dl");
  const rows = [
    ["Tipo", p.tipo],
    ["Mes", p.periodo ? monthLabel(p.periodo) : ""],
    ["Ingreso", dateLabel(p.fechaPago)],
    ["Importe", fmtAmount(p.importe)],
    ["Nota", (file.description || "").split("\n").find((l) => l.startsWith("Nota: "))?.slice(6)],
  ];
  for (const [k, v] of rows) {
    if (!v) continue;
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    dl.append(dt, dd);
  }
  $("viewerInfo").appendChild(dl);
  $("viewerDialog").showModal();
  try {
    const r = await api(`${DRIVE}/files/${file.id}?alt=media`);
    const blob = await r.blob();
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = URL.createObjectURL(blob);
    $("viewerImg").src = viewerUrl;
    $("viewerLoading").hidden = true;
  } catch (e) {
    if (e instanceof AuthError) return login();
    $("viewerLoading").textContent = "No se pudo cargar la imagen (¿sin conexión?)";
  }
}

async function trashCurrent() {
  if (!viewerFile || !confirm("¿Mover este comprobante a la papelera de Drive? Podrás recuperarlo desde Drive durante 30 días.")) return;
  try {
    await api(`${DRIVE}/files/${viewerFile.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
    store.set("files", store.get("files", []).filter((f) => f.id !== viewerFile.id));
    $("viewerDialog").close();
    renderFiles();
    toast("Movido a la papelera de Drive");
  } catch (e) {
    if (e instanceof AuthError) return login();
    toast("Error: " + e.message);
  }
}

// ---------- Render ----------
let filter = "Todos";

async function renderPending() {
  let n = 0;
  try { n = (await idb.all()).length; } catch {}
  const b = $("pendingBanner");
  b.hidden = n === 0;
  if (n) {
    b.innerHTML = "";
    const s = document.createElement("span");
    s.textContent = `${n} comprobante${n > 1 ? "s" : ""} pendiente${n > 1 ? "s" : ""} de subir (guardado${n > 1 ? "s" : ""} en el móvil)`;
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = processing ? "Subiendo…" : "Reintentar";
    btn.disabled = processing;
    btn.onclick = processQueue;
    b.append(s, btn);
  }
}

function renderStatus(files) {
  const cols = TIPOS.filter((t) => t !== "Otro").slice(0, 3);
  const g = $("statusGrid");
  g.style.setProperty("--cols", cols.length);
  g.innerHTML = "";
  const have = new Set(files.map((f) => `${f.appProperties?.periodo}|${f.appProperties?.tipo}`));
  const head = document.createElement("div");
  head.className = "status-row head";
  head.innerHTML = "<span>Mes</span>";
  cols.forEach((c) => { const s = document.createElement("span"); s.textContent = c; head.appendChild(s); });
  g.appendChild(head);
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const p = monthISO(new Date(now.getFullYear(), now.getMonth() - i, 1));
    const row = document.createElement("div");
    row.className = "status-row";
    const name = document.createElement("span");
    name.className = "month-name";
    name.textContent = monthLabel(p, { month: "short", year: "numeric" });
    row.appendChild(name);
    for (const c of cols) {
      const cell = document.createElement("span");
      const ok = have.has(`${p}|${c}`);
      cell.innerHTML = `<span class="pill ${ok ? "ok" : "miss"}" title="${ok ? "Guardado" : "Sin comprobante"}">${ok ? "✓" : "—"}</span>`;
      row.appendChild(cell);
    }
    g.appendChild(row);
  }
}

function renderFilters() {
  const f = $("filters");
  f.innerHTML = "";
  for (const t of ["Todos", ...TIPOS]) {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = t === "Todos" ? t : `${ICONS[t] || "🧾"} ${t}`;
    b.setAttribute("aria-pressed", String(t === filter));
    b.onclick = () => { filter = t; renderFilters(); renderFiles(); };
    f.appendChild(b);
  }
}

function renderFiles() {
  const files = store.get("files", []);
  renderStatus(files);
  const list = $("list");
  list.innerHTML = "";
  const shown = files
    .filter((f) => filter === "Todos" || f.appProperties?.tipo === filter)
    .sort((a, b) => (b.appProperties?.periodo || "").localeCompare(a.appProperties?.periodo || "") || (b.createdTime || "").localeCompare(a.createdTime || ""));
  if (!shown.length) {
    list.innerHTML = `<div class="empty">Aún no hay comprobantes${filter !== "Todos" ? " de este tipo" : ""}.<br>Pulsa “Nuevo comprobante” para hacer la primera foto.</div>`;
    return;
  }
  let year = null, box = null;
  for (const f of shown) {
    const p = f.appProperties || {};
    const y = (p.periodo || "").slice(0, 4) || "Sin fecha";
    if (y !== year) {
      year = y;
      const h = document.createElement("div");
      h.className = "year";
      h.textContent = y;
      box = document.createElement("div");
      box.className = "items";
      list.append(h, box);
    }
    const it = document.createElement("button");
    it.className = "item";
    it.innerHTML = `<span class="item-badge"></span><span class="item-main"><div class="item-title"></div><div class="item-sub"></div></span><span class="item-amount"></span>`;
    it.querySelector(".item-badge").textContent = ICONS[p.tipo] || "🧾";
    it.querySelector(".item-title").textContent = `${p.tipo || ""} · ${p.periodo ? monthLabel(p.periodo, { month: "long" }) : f.name}`;
    it.querySelector(".item-sub").textContent = p.fechaPago ? `Ingresado el ${dateLabel(p.fechaPago)}` : f.name;
    it.querySelector(".item-amount").textContent = fmtAmount(p.importe);
    it.onclick = () => openViewer(f);
    box.appendChild(it);
  }
}

async function syncFiles() {
  $("refreshBtn").disabled = true;
  try {
    store.set("files", await listReceipts());
    renderFiles();
  } catch (e) {
    if (e instanceof AuthError) return;
    toast("Sin conexión con Drive; mostrando lo último guardado");
  } finally {
    $("refreshBtn").disabled = false;
  }
}

function render() {
  const configured = !!CFG.GOOGLE_CLIENT_ID;
  const user = store.get("user");
  const connected = configured && (getToken() || user);
  $("setupView").hidden = configured;
  $("loginView").hidden = !configured || connected;
  $("mainView").hidden = !connected;
  $("accountBtn").hidden = !connected;
  if (connected) {
    $("accountBtn").textContent = "Salir";
    $("accountBtn").title = user?.email || "";
    renderFilters();
    renderFiles();
    renderPending();
  }
}

// ---------- Arranque ----------
async function init() {
  handleOAuthRedirect();
  render();

  $("loginBtn").onclick = () => login(true);
  $("accountBtn").onclick = () => { if (confirm(`¿Desconectar ${store.get("user")?.email || "Google Drive"}? Tus fotos siguen en Drive.`)) logout(); };
  $("fileInput").onchange = onFilePicked;
  $("galleryInput").onchange = onFilePicked;
  $("enhance").onchange = refreshPreview;
  $("receiptForm").onsubmit = onSave;
  $("cancelBtn").onclick = () => { $("formDialog").close(); currentImg = null; };
  $("closeViewerBtn").onclick = () => $("viewerDialog").close();
  $("trashBtn").onclick = trashCurrent;
  $("refreshBtn").onclick = () => getToken() ? syncFiles() : login();
  window.addEventListener("online", () => getToken() && processQueue());

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  if (!CFG.GOOGLE_CLIENT_ID) return;
  if (getToken()) {
    if (!store.get("user")) { try { await loadUser(); render(); } catch {} }
    await processQueue();
    await syncFiles();
  } else if (store.get("user")) {
    // Sesión caducada (Google da tokens de 1 hora): si hay subidas pendientes, reconectar ya.
    const pending = await idb.all().catch(() => []);
    if (pending.length) login();
  }

  // Si el token caduca, al abrir la cámara se renueva primero para no perder la foto.
  for (const id of ["fileInput", "galleryInput"]) {
    document.querySelector(`label[for="${id}"]`).addEventListener("click", (e) => {
      if (!getToken()) { e.preventDefault(); login(); }
    });
  }
}

init();
