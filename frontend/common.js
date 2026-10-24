// Utilidades compartidas por los tres sitios: público (/), staff (/staff) y admin (/admin).
// El backend sirve estas páginas, así que la API está en el mismo origen
const API = (localStorage.getItem('ticketera_api') || location.origin) + '/api';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = (n) => '$' + Number(n).toLocaleString('es-AR');

function flash(text, type = 'ok') {
  $('msg').innerHTML = text ? `<div class="msg ${type}">${esc(text)}</div>` : '';
  if (text) window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Sesión guardada por sitio (staff y admin no se pisan si comparten el navegador).
// La crea cada página con createSession('staff' | 'admin')
let session = { token: null, user: null };
function createSession(site) {
  const key = 'ticketera_session_' + site;
  try { session = JSON.parse(localStorage.getItem(key)) || session; } catch { /* sesión corrupta: se ignora */ }
  return {
    set(token, user) {
      session = { token, user };
      if (token) localStorage.setItem(key, JSON.stringify(session));
      else localStorage.removeItem(key);
    },
  };
}

// Si el backend responde 401 la sesión venció o el usuario fue borrado
let onUnauthorized = () => {};

async function api(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && session.token) headers.Authorization = 'Bearer ' + session.token;
  let res;
  try { res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new Error('No se pudo conectar con el servidor'); }
  const data = await res.json().catch(() => ({}));
  if (auth && res.status === 401) onUnauthorized();
  if (!res.ok || data.success === false) throw new Error(data.message || 'Error ' + res.status);
  return data;
}

// Formulario de login para staff y admin. allowedRoles: roles que pueden entrar a ese sitio
function renderLogin(title, allowedRoles, onLogin) {
  $('view').innerHTML = `
  <div class="card" style="max-width:380px;margin:auto">
    <h2>${esc(title)}</h2>
    <form id="loginForm">
      <label>Email</label><input id="aEmail" type="email" required autocomplete="username">
      <label>Contraseña</label><input id="aPass" type="password" required autocomplete="current-password">
      <p><button>Ingresar</button></p>
    </form>
  </div>`;
  $('loginForm').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const { token, user } = await api('/auth/login', { method: 'POST', body: { email: $('aEmail').value.trim(), password: $('aPass').value } });
      if (!allowedRoles.includes(user.role)) throw new Error('Esta cuenta no tiene acceso a esta sección');
      onLogin(token, user);
    } catch (err) { flash(err.message, 'err'); }
  };
}
