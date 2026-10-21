'use strict';
/* LG Remote PWA : protocole SSAP webOS implémenté à la main. */
const $ = s => document.querySelector(s);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
};
const HTTPS = location.protocol === 'https:';
const QUICK = [
  { id: 'netflix', title: 'Netflix', bg: '#e50914' },
  { id: 'youtube.leanback.v4', title: 'YouTube', bg: '#ff0000' },
  { id: 'amazon', title: 'Prime', bg: '#00a8e1' },
  { id: 'com.disney.disneyplus-prod', title: 'Disney+', bg: '#113ccf' },
];

/* ---------------- état ---------------- */
let ws = null, pointer = null, reqId = 0, pending = new Map();
let current = null;          // {ip, secure}
let wantConnected = false, retry = 0, retryTimer = null, registered = false;

function setStatus(text, cls) { const s = $('#status'); s.textContent = text; s.className = cls; }
function banner(msg, info) {
  const b = $('#banner');
  if (!msg) { b.classList.add('hidden'); return; }
  b.textContent = msg; b.className = 'banner' + (info ? ' info' : '');
}
function showRemote(on) { $('#remote').classList.toggle('hidden', !on); $('#setup').classList.toggle('hidden', on); }

/* ---------------- SSAP ---------------- */
function urlFor(ip, secure) { return secure ? `wss://${ip}:3001` : `ws://${ip}:3000`; }
function keyName(ip) { return 'clientKey:' + ip; }

function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function request(uri, payload = {}, timeout = 8000) {
  return new Promise((res, rej) => {
    if (!ws || ws.readyState !== 1 || !registered) return rej(new Error('Non connecté à la TV'));
    const id = 'req_' + (++reqId);
    const t = setTimeout(() => { pending.delete(id); rej(new Error('Délai dépassé : la TV ne répond pas')); }, timeout);
    pending.set(id, { res, rej, t });
    send({ type: 'request', id, uri, payload });
  });
}

function connect(ip, secure) {
  cleanup();
  current = { ip, secure }; wantConnected = true;
  LS.set('lastTv', current);
  $('#tvName').textContent = (LS.get('tvs', {})[ip] || {}).name || ip;
  setStatus('Connexion…', 'st-wait');
  const started = Date.now();
  let opened = false;
  let sock;
  try { sock = new WebSocket(urlFor(ip, secure)); }
  catch (e) { return fail(secure && !HTTPS ? e.message : 'URL refusée par le navigateur : ' + e.message, false); }
  ws = sock;
  const openTimer = setTimeout(() => { if (!opened) { sock.close(); fail('Délai dépassé : TV éteinte, IP incorrecte ou téléphone sur un autre réseau.', true); } }, 7000);

  sock.onopen = () => {
    opened = true; clearTimeout(openTimer);
    setStatus('Appairage…', 'st-wait');
    const pairing = JSON.parse(JSON.stringify(window.LG_PAIRING));
    const k = LS.get(keyName(ip), null);
    if (k) pairing['client-key'] = k;
    send({ type: 'register', id: 'register_0', payload: pairing });
  };
  sock.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id === 'register_0') return onRegister(m);
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id); clearTimeout(p.t);
      if (m.type === 'error' || (m.payload && m.payload.returnValue === false))
        p.rej(new Error((m.error || m.payload.errorText || 'Erreur TV')));
      else p.res(m.payload || {});
    }
  };
  sock.onerror = () => { /* le détail n'est jamais exposé par le navigateur, voir onclose */ };
  sock.onclose = () => {
    clearTimeout(openTimer);
    if (ws !== sock) return;
    const dt = Date.now() - started;
    if (!opened) {
      if (secure && dt < 4000)
        fail('Échec de la connexion sécurisée. Le certificat de la TV n’est probablement pas encore accepté : touchez « Autoriser le certificat », acceptez-le, puis reconnectez. Sinon la TV est éteinte ou l’IP est fausse.', true);
      else fail('Impossible de joindre la TV (éteinte, mauvaise IP ou mauvais réseau Wi-Fi).', true);
    } else {
      fail('Connexion perdue avec la TV.', true);
    }
  };
}

function onRegister(m) {
  if (m.type === 'error') {
    const e = String(m.error || '');
    wantConnected = false;
    if (/403|cancel|denied|reject/i.test(e)) {
      LS.set(keyName(current.ip), null);
      fail('Appairage refusé sur la TV. Réessayez « Connecter » et choisissez « Accepter » sur l’écran de la TV.', false);
    } else fail('Erreur d’appairage : ' + e, false);
    return;
  }
  if (m.type === 'response' && m.payload && m.payload.pairingType === 'PROMPT') {
    setStatus('Acceptez sur la TV', 'st-wait');
    banner('Une demande d’appairage s’affiche sur la TV : acceptez-la avec la télécommande.', true);
    return;
  }
  if (m.type === 'registered') {
    registered = true; retry = 0;
    const key = m.payload && m.payload['client-key'];
    if (key) LS.set(keyName(current.ip), key);
    saveTv(current.ip, { secure: current.secure });
    setStatus('Connecté', 'st-on'); banner(null); showRemote(true);
    openPointer();
    request('ssap://system/getSystemInfo').then(i => { if (i.modelName) saveTv(current.ip, { model: i.modelName }); }).catch(() => {});
    request('ssap://com.webos.applicationManager/getForegroundAppInfo').catch(() => {});
  }
}

async function openPointer() {
  try {
    const r = await request('ssap://com.webos.service.networkinput/getPointerInputSocket');
    let path = r.socketPath;
    if (!path) throw new Error('pas de socketPath');
    // Page HTTPS : forcer wss:3001 même si la TV renvoie ws://:3000
    if (HTTPS || current.secure) path = path.replace(/^ws:\/\/([^/:]+):3000/, 'wss://$1:3001');
    const p = new WebSocket(path);
    p.onopen = () => { pointer = p; };
    p.onclose = () => { if (pointer === p) pointer = null; if (registered && wantConnected) setTimeout(openPointer, 1500); };
  } catch (e) { banner('Pavé directionnel indisponible : ' + e.message); }
}

function button(name) {
  if (pointer && pointer.readyState === 1) { pointer.send(`type:button\nname:${name}\n\n`); vibrate(); return; }
  banner('Socket de navigation non prête, nouvelle tentative…'); if (registered) openPointer();
}
function vibrate() { if (navigator.vibrate) navigator.vibrate(10); }

function fail(msg, canRetry) {
  registered = false;
  if (pointer) { try { pointer.close(); } catch {} pointer = null; }
  for (const p of pending.values()) { clearTimeout(p.t); p.rej(new Error(msg)); }
  pending.clear();
  setStatus('Déconnecté', 'st-err');
  banner(msg);
  if (canRetry && wantConnected) {
    const delay = Math.min(30000, 1000 * 2 ** retry++);
    setStatus(`Nouvel essai dans ${Math.round(delay / 1000)} s`, 'st-err');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (wantConnected && current) connect(current.ip, current.secure); }, delay);
  }
}
function cleanup() {
  clearTimeout(retryTimer);
  registered = false;
  if (pointer) { try { pointer.close(); } catch {} pointer = null; }
  if (ws) { const w = ws; ws = null; try { w.close(); } catch {} }
}
document.addEventListener('visibilitychange', () => {
  // iOS coupe les sockets en arrière-plan : on reconnecte au retour
  if (document.visibilityState === 'visible' && wantConnected && current && (!ws || ws.readyState > 1)) { retry = 0; connect(current.ip, current.secure); }
});

/* ---------------- commandes ---------------- */
async function cmd(uri, payload) {
  try { const r = await request(uri, payload); vibrate(); return r; }
  catch (e) { banner(e.message); }
}
async function toggleMute() {
  try {
    const s = await request('ssap://audio/getStatus');
    await request('ssap://audio/setMute', { mute: !s.mute }); vibrate();
  } catch (e) { banner(e.message); }
}
function launch(id) {
  cmd('ssap://system.launcher/launch', { id }).then(r => { if (!r) return; });
}
async function showApps() {
  const dlg = $('#appsDlg'), list = $('#appList');
  list.innerHTML = '<li>Chargement…</li>'; dlg.showModal();
  try {
    const r = await request('ssap://com.webos.applicationManager/listLaunchPoints');
    const pts = (r.launchPoints || []).sort((a, b) => a.title.localeCompare(b.title));
    list.innerHTML = '';
    for (const a of pts) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="t"></span><button>Ouvrir</button>`;
      li.querySelector('.t').textContent = a.title;
      li.querySelector('button').onclick = () => { launch(a.id); dlg.close(); };
      list.appendChild(li);
    }
    if (!pts.length) list.innerHTML = '<li>Aucune application</li>';
  } catch (e) { list.innerHTML = ''; const li = document.createElement('li'); li.textContent = e.message; list.appendChild(li); }
}

/* ---------------- TV enregistrées ---------------- */
function saveTv(ip, extra) {
  const tvs = LS.get('tvs', {});
  tvs[ip] = Object.assign({ name: 'TV LG ' + ip }, tvs[ip], extra);
  if (extra.model) tvs[ip].name = 'LG ' + extra.model;
  LS.set('tvs', tvs); renderSaved();
  if (current && current.ip === ip) $('#tvName').textContent = tvs[ip].name;
}
function renderSaved() {
  const tvs = LS.get('tvs', {}), ul = $('#savedList'); ul.innerHTML = '';
  const ips = Object.keys(tvs);
  if (!ips.length) { ul.innerHTML = '<li><span class="t">Aucune</span></li>'; return; }
  for (const ip of ips) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="t"><b></b><small></small></span><button class="go">Connecter</button><button class="del">✕</button>`;
    li.querySelector('b').textContent = tvs[ip].name;
    li.querySelector('small').textContent = ip + (LS.get(keyName(ip), null) ? ' · appairée' : '');
    li.querySelector('.go').onclick = () => { $('#ip').value = ip; startConnect(); };
    li.querySelector('.del').onclick = () => { const t = LS.get('tvs', {}); delete t[ip]; LS.set('tvs', t); localStorage.removeItem(keyName(ip)); renderSaved(); };
    ul.appendChild(li);
  }
}

/* ---------------- scan ---------------- */
function probe(ip, secure, timeout) {
  return new Promise(res => {
    const t0 = performance.now(); let done = false, s;
    const end = (state) => { if (done) return; done = true; clearTimeout(tm); try { s.close(); } catch {} res({ ip, state, ms: performance.now() - t0 }); };
    try { s = new WebSocket(urlFor(ip, secure)); } catch { return res({ ip, state: 'err', ms: 0 }); }
    const tm = setTimeout(() => end('timeout'), timeout);
    s.onopen = () => end('open');
    s.onclose = () => end('closed');
  });
}
let scanning = false;
async function scan() {
  if (scanning) { scanning = false; return; }
  const secure = !$('#useWs').checked;
  const subnets = $('#subnets').value.split(',').map(s => s.trim()).filter(s => /^\d+\.\d+\.\d+$/.test(s));
  const hosts = [];
  for (const sn of subnets) { const max = sn === '172.20.10' ? 14 : 254; for (let i = 1; i <= max; i++) hosts.push(`${sn}.${i}`); }
  const ul = $('#scanList'), prog = $('#scanProg'); ul.innerHTML = '';
  prog.classList.remove('hidden'); prog.max = hosts.length; prog.value = 0;
  scanning = true; $('#btnScan').textContent = 'Arrêter';
  const found = [];
  let idx = 0;
  const worker = async () => {
    while (scanning && idx < hosts.length) {
      const ip = hosts[idx++];
      const r = await probe(ip, secure, 2500);
      prog.value++;
      // open = TV confirmée (certificat déjà accepté ou ws://).
      // fermé vite = hôte présent ; en wss sans certificat accepté on ne peut pas distinguer TV / autre appareil.
      if (r.state === 'open' || (r.state === 'closed' && r.ms < 1500 && secure)) { found.push(r); addScan(r); }
    }
  };
  await Promise.all(Array.from({ length: 24 }, worker));
  scanning = false; $('#btnScan').textContent = 'Scanner'; prog.classList.add('hidden');
  if (!found.length) ul.innerHTML = '<li><span class="t">Rien trouvé. Vérifiez le Wi-Fi ou saisissez l’IP (TV : Réglages → Réseau → État).</span></li>';
}
function addScan(r) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="t"><b></b><small></small></span><button>Choisir</button>`;
  li.querySelector('b').textContent = r.ip;
  li.querySelector('small').textContent = r.state === 'open' ? 'TV LG webOS confirmée' : 'Appareil qui répond (TV possible, certificat à accepter)';
  li.querySelector('button').onclick = () => { $('#ip').value = r.ip; };
  r.state === 'open' ? $('#scanList').prepend(li) : $('#scanList').appendChild(li);
}

/* ---------------- UI ---------------- */
function ipVal() {
  const ip = $('#ip').value.trim();
  if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip) || ip.split('.').some(n => +n > 255)) { banner('Adresse IP invalide (ex. 192.168.1.42).'); return null; }
  return ip;
}
function startConnect() {
  const ip = ipVal(); if (!ip) return;
  retry = 0; banner(null); connect(ip, !$('#useWs').checked);
}
function init() {
  if (HTTPS) {
    $('#useWs').checked = false; $('#useWs').disabled = true;
    $('#wsHint').textContent = 'Page en HTTPS : seul wss://IP:3001 est autorisé par Safari. Pour ws://3000, ouvrez la version http:// de cette page si l’hébergeur le permet.';
  } else $('#wsHint').textContent = 'Page en HTTP : ws://IP:3000 possible (pas de certificat à accepter, mais certaines TV récentes ferment le port 3000).';
  for (const a of QUICK) {
    const b = document.createElement('button'); b.textContent = a.title; b.style.background = a.bg;
    b.onclick = () => launch(a.id); $('#quickApps').appendChild(b);
  }
  document.querySelectorAll('[data-btn]').forEach(b => b.addEventListener('click', () => button(b.dataset.btn)));
  $('#volUp').onclick = () => cmd('ssap://audio/volumeUp');
  $('#volDown').onclick = () => cmd('ssap://audio/volumeDown');
  $('#mute').onclick = toggleMute;
  $('#btnPower').onclick = () => { if (registered && confirm('Éteindre la TV ?')) { cmd('ssap://system/turnOff'); wantConnected = false; } };
  $('#btnApps').onclick = showApps; $('#closeApps').onclick = () => $('#appsDlg').close();
  $('#btnSetup').onclick = () => showRemote($('#remote').classList.contains('hidden') && registered);
  $('#btnConnect').onclick = startConnect;
  $('#btnScan').onclick = scan;
  $('#btnCert').onclick = () => { const ip = ipVal(); if (ip) window.open(`https://${ip}:3001/`, '_blank'); };
  renderSaved();
  const last = LS.get('lastTv', null);
  if (last && last.ip) { $('#ip').value = last.ip; if (!HTTPS) $('#useWs').checked = !last.secure; connect(last.ip, HTTPS ? true : last.secure); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
