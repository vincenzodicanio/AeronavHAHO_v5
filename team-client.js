/* team-client.js - Team Live per AERONAV HAHO
 *
 * Uso minimo:
 *   AeronavTeam.configure({ server: "https://tuo-dominio" });
 *
 *   // 1) creare un gruppo oppure entrare con un codice / link d'invito
 *   await AeronavTeam.createGroup("Marco", "DZ Sabato");
 *   await AeronavTeam.joinGroup("TG99-73E2", "Giulia");
 *
 *   // 2) avviare la sincronizzazione (ogni 5 s)
 *   AeronavTeam.start({
 *     getFix: () => ({ lat, lon, alt, gs, hdg, vs, acc, ts }),   // opzionale: il GPS gia' usato dal navigatore
 *     onMembers: (members) => { ... },                             // membri con posizione recente (anche tu, m.you)
 *     onRoster:  (members) => { ... },                             // TUTTI i membri, anche senza posizione
 *     onStatus:  (s) => { ... },                                   // { online: true|false }
 *     onLost:    () => { ... }                                     // gruppo/token non piu' validi: rientrare
 *   });
 *
 *   // 3) invitare
 *   AeronavTeam.shareInvite();           // menu "Condividi" del telefono (WhatsApp, Telegram...)
 *
 *   // 4) all'apertura della pagina: link d'invito?
 *   const code = AeronavTeam.pendingInvite();   // es. "TG9973E2" oppure null
 *
 * Se usi Leaflet:  const render = AeronavTeam.attachLeaflet(map);  e poi  onMembers: render
 */
(function (global) {
  "use strict";

  const LS_KEY = "aeronav.team.v1";
  const SYNC_MS = 5000;        // intervallo di aggiornamento
  const SYNC_TIMEOUT_MS = 4500; // una richiesta lenta non si accavalla alla successiva
  const FIX_MAX_AGE_MS = 15000; // un fix GPS piu' vecchio non viene inviato
  const STALE_S = 30;          // oltre: marker "grigio"
  const HIDE_S = 600;          // oltre: non mostrare

  let cfg = { server: "" };
  let st = load();             // { nick, code, uid, token, groupName }
  let timer = null, busy = false, handlers = {};
  let lastFix = null, watchId = null, wakeLock = null;

  function load() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
  }
  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(st)); } catch (e) { /* storage pieno/bloccato */ }
  }
  function fmtCode(c) { c = String(c || ""); return c.length === 8 ? c.slice(0, 4) + "-" + c.slice(4) : c; }
  function cleanCode(c) { return String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }

  function configure(o) { cfg = Object.assign(cfg, o || {}); cfg.server = String(cfg.server || "").replace(/\/+$/, ""); }

  async function api(method, path, body, auth, timeoutMs) {
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), timeoutMs || 8000);
    try {
      const headers = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (auth && st.token) headers["Authorization"] = "Bearer " + st.token;
      const r = await fetch(cfg.server + path, {
        method, headers, signal: ctl.signal,
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const e = new Error(data.error || ("HTTP " + r.status));
        e.status = r.status;
        throw e;
      }
      return data;
    } finally { clearTimeout(timeout); }
  }

  function adopt(d) {
    st = { nick: d.nickname, code: d.group_code, uid: d.user_id, token: d.token, groupName: d.group_name };
    save();
    return d;
  }

  async function createGroup(nickname, groupName) {
    return adopt(await api("POST", "/groups", { nickname: nickname, name: groupName || "" }));
  }
  async function joinGroup(code, nickname) {
    return adopt(await api("POST", "/groups/" + cleanCode(code) + "/join", { nickname: nickname }));
  }
  async function groupInfo(code) {
    return api("GET", "/groups/" + cleanCode(code) + "/info");
  }
  async function leave() {
    const { code, uid } = st;
    stop();
    try { if (code) await api("DELETE", "/groups/" + code + "/members/" + uid, undefined, true, 5000); } catch (e) { /* offline: pazienza */ }
    st = { nick: st.nick };
    save();
  }

  // ---- inviti ----
  function inviteLink() {
    let url = location.origin + location.pathname + "?join=" + encodeURIComponent(st.code || "");
    if (cfg.server) url += "&srv=" + encodeURIComponent(cfg.server);
    return url;
  }
  async function shareInvite() {
    if (!st.code) return "no-group";
    const url = inviteLink();
    const text = "Unisciti al gruppo \"" + st.groupName + "\" su AERONAV HAHO. Codice: " + fmtCode(st.code);
    if (navigator.share) {
      try { await navigator.share({ title: "AERONAV HAHO", text: text, url: url }); return "shared"; }
      catch (e) { if (e && e.name === "AbortError") return "cancelled"; }
    }
    try { await navigator.clipboard.writeText(text + "\n" + url); return "copied"; } catch (e) { /* ignora */ }
    return "failed";
  }
  function pendingInvite() {
    const c = new URLSearchParams(location.search).get("join");
    return c ? cleanCode(c) : null;
  }
  function pendingInviteServer() {
    const s = new URLSearchParams(location.search).get("srv");
    return s ? s : null;
  }
  function clearInviteFromUrl() {
    const u = new URL(location.href);
    u.searchParams.delete("join");
    u.searchParams.delete("srv");
    history.replaceState(null, "", u);
  }

  // ---- GPS proprio (usato solo se non passi getFix) ----
  function startOwnGps() {
    if (!navigator.geolocation || watchId !== null) return;
    watchId = navigator.geolocation.watchPosition(function (p) {
      const c = p.coords;
      lastFix = { lat: c.latitude, lon: c.longitude, alt: c.altitude, gs: c.speed, hdg: c.heading, acc: c.accuracy, ts: p.timestamp };
    }, function () { /* permesso negato o fix assente */ }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
  }
  function stopOwnGps() {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  }
  async function wakeLockOn() {
    try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { /* non supportato */ }
  }
  function wakeLockOff() {
    try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignora */ }
    wakeLock = null;
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && timer) { wakeLockOn(); tick(); }
  });

  // ---- ciclo di sincronizzazione ----
  async function tick() {
    if (busy || !st.code) return;   // se la richiesta precedente e' ancora in corso, salta
    busy = true;
    try {
      const f = handlers.getFix ? handlers.getFix() : lastFix;
      const body = {};
      if (f && Number.isFinite(f.lat) && Number.isFinite(f.lon) && !(f.ts && Date.now() - f.ts > FIX_MAX_AGE_MS)) {
        ["lat", "lon", "alt", "gs", "hdg", "vs", "acc"].forEach(function (k) {
          if (Number.isFinite(f[k])) body[k] = f[k];
        });
      }
      const d = await api("POST", "/groups/" + st.code + "/members/" + st.uid + "/sync", body, true, SYNC_TIMEOUT_MS);
      if (handlers.onStatus) handlers.onStatus({ online: true });
      if (handlers.onRoster) {
        handlers.onRoster(d.members.map(function (m) {
          return Object.assign({}, m, { stale: m.age == null || m.age > STALE_S, hidden: m.age == null || m.age >= HIDE_S });
        }));
      }
      if (handlers.onMembers) {
        handlers.onMembers(d.members
          .filter(function (m) { return m.lat != null && m.age != null && m.age < HIDE_S; })
          .map(function (m) { return Object.assign({}, m, { stale: m.age > STALE_S }); }));
      }
    } catch (e) {
      if (e.status === 404 || e.status === 401) {   // gruppo scaduto o membro rimosso dal server
        const nick = st.nick;
        stop();
        st = { nick: nick };
        save();
        if (handlers.onLost) handlers.onLost(e);
      } else if (handlers.onStatus) {
        handlers.onStatus({ online: false, error: e.message });   // rete cellulare assente: riprova al giro dopo
      }
    } finally { busy = false; }
  }

  function start(opts) {
    handlers = opts || {};
    if (!st.code || timer) return;
    if (!handlers.getFix) startOwnGps();
    wakeLockOn();
    tick();
    timer = setInterval(tick, SYNC_MS);
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    stopOwnGps();
    wakeLockOff();
  }

  // ---- marker Leaflet (opzionale) ----
  function attachLeaflet(map, opts) {
    const showSelf = !!(opts && opts.showSelf);
    const markers = new Map();
    if (!document.getElementById("team-pin-css")) {
      const css = document.createElement("style");
      css.id = "team-pin-css";
      css.textContent =
        ".team-pin{position:relative;transform:translate(-7px,-7px)}" +
        ".team-pin .dot{display:block;width:14px;height:14px;border-radius:50%;background:var(--c);border:2px solid #fff;box-shadow:0 0 3px #000}" +
        ".team-pin .lbl{position:absolute;left:18px;top:-3px;white-space:nowrap;font:600 12px system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.65);padding:1px 5px;border-radius:4px}" +
        ".team-pin.stale{opacity:.5}";
      document.head.appendChild(css);
    }
    function color(id) { return "hsl(" + (parseInt(id.slice(0, 4), 16) % 360) + ",70%,45%)"; }

    return function render(members) {
      const seen = new Set();
      members.forEach(function (m) {
        if (m.you && !showSelf) return;
        seen.add(m.id);
        const el = document.createElement("div");
        el.className = "team-pin" + (m.stale ? " stale" : "");
        el.style.setProperty("--c", color(m.id));
        const dot = document.createElement("span"); dot.className = "dot";
        const lbl = document.createElement("span"); lbl.className = "lbl";
        lbl.textContent = m.nick + (Number.isFinite(m.alt) ? " " + Math.round(m.alt) + " m" : "");   // textContent: niente HTML iniettato
        el.appendChild(dot); el.appendChild(lbl);
        const icon = L.divIcon({ html: el, className: "", iconSize: [0, 0] });
        let mk = markers.get(m.id);
        if (!mk) { mk = L.marker([m.lat, m.lon], { icon: icon, keyboard: false }).addTo(map); markers.set(m.id, mk); }
        else { mk.setLatLng([m.lat, m.lon]); mk.setIcon(icon); }
      });
      markers.forEach(function (mk, id) {
        if (!seen.has(id)) { map.removeLayer(mk); markers.delete(id); }
      });
    };
  }

  global.AeronavTeam = {
    configure: configure,
    state: function () { return Object.assign({}, st); },
    inGroup: function () { return !!st.code; },
    savedNickname: function () { return st.nick || ""; },
    fmtCode: fmtCode,
    createGroup: createGroup,
    joinGroup: joinGroup,
    groupInfo: groupInfo,
    leave: leave,
    inviteLink: inviteLink,
    shareInvite: shareInvite,
    pendingInvite: pendingInvite,
    pendingInviteServer: pendingInviteServer,
    clearInviteFromUrl: clearInviteFromUrl,
    start: start,
    stop: stop,
    attachLeaflet: attachLeaflet
  };
})(window);
