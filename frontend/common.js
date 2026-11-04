// Utilidades compartidas por los tres sitios: público (/), staff (/staff) y admin (/admin).
// El backend sirve estas páginas, así que la API está en el mismo origen
const API = (localStorage.getItem('ticketera_api') || location.origin) + '/api';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Edad mínima de un evento (null si no tiene). Los eventos viejos con adultsOnly sin minAge valen 18.
const ageOf = (e) => e.minAge || (e.adultsOnly ? 18 : null);
const money = (n) => '$' + Number(n).toLocaleString('es-AR');

function flash(text, type = 'ok') {
  $('msg').innerHTML = text ? `<div class="msg ${type}">${esc(text)}</div>` : '';
  if (text) window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Link privado de las entradas de una compra: el mismo que llega por email
const purchaseLink = (token) => location.origin + '/#/entradas/' + token;

// Copiar el link de las entradas. btn (opcional) muestra "¡Copiado!" un momento
async function copyPurchaseLink(token, btn) {
  const url = purchaseLink(token);
  try {
    await navigator.clipboard.writeText(url);
    if (btn) {
      const text = btn.textContent;
      btn.textContent = '¡Copiado!';
      setTimeout(() => { btn.textContent = text; }, 1800);
    }
  } catch {
    // Sin permiso para el portapapeles (por ejemplo en http): se muestra para copiarlo a mano
    window.prompt('Copiá el link de las entradas:', url);
  }
}

// Panel (admin y organizador): reenviar por email las entradas de una compra pagada.
// El email sale al comprador, así que se pide confirmar antes
async function resendTicketsEmail(eventId, purchaseId, btn) {
  if (!confirm('¿Enviar las entradas a ' + btn.dataset.email + '?')) return;
  btn.disabled = true;
  try {
    const { message } = await api('/purchases/event/' + eventId + '/' + purchaseId + '/resend', { method: 'POST', auth: true });
    flash(message);
  } catch (err) { flash(err.message, 'err'); }
  finally { btn.disabled = false; }
}

// Panel (admin y organizador): anular las entradas de una compra pagada. No devuelve la plata
async function voidPurchaseTickets(eventId, purchaseId, btn) {
  const input = window.prompt('Las entradas de ' + btn.dataset.name + ' dejarán de ser válidas en la puerta. Esto no devuelve el dinero.\n\nIndicá el motivo (sin datos personales del comprador: ni email ni DNI) de la anulación (3 a 200 caracteres):');
  if (input === null) return;
  const reason = input.trim();
  if (reason.length < 3 || reason.length > 200) {
    flash('El motivo de la anulación debe tener entre 3 y 200 caracteres.', 'err');
    return;
  }
  btn.disabled = true;
  try {
    const { message } = await api('/purchases/event/' + eventId + '/' + purchaseId + '/void', { method: 'POST', auth: true, body: { reason } });
    await viewBuyers(eventId);
    flash(message);
  } catch (err) { btn.disabled = false; flash(err.message, 'err'); }
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
