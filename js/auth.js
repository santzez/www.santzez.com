/* =============================================================
   auth.js — Gestión de autenticación
   -------------------------------------------------------------
   IMPORTANTE: este módulo valida usuarios contra un JSON estático
   con contraseñas hasheadas en SHA-256. Es suficiente para un
   proyecto personal, PERO CUALQUIERA QUE DESCARGUE EL JSON
   PUEDE INTENTAR CRACKEAR LOS HASHES. No uses este sistema para
   datos sensibles. Para producción real, migrar a Supabase/Firebase.
   ============================================================= */

const AuthSession = {
  LS_KEY: 'oposizioak.sesion',

  // Hashea una cadena con SHA-256 (hex)
  async hash(texto) {
    const buffer = new TextEncoder().encode(texto);
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  },

  // Devuelve la sesión actual ({usuario, desde}) o null
  get() {
    try {
      const raw = localStorage.getItem(this.LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  // Guarda la sesión
  set(usuario) {
    localStorage.setItem(
      this.LS_KEY,
      JSON.stringify({ usuario, desde: new Date().toISOString() })
    );
  },

  // Cierra sesión
  logout() {
    localStorage.removeItem(this.LS_KEY);
    window.location.href = '/login.html';
  },

  // Protege una página: redirige a login si no hay sesión
  exigirLogin() {
    const sesion = this.get();
    if (!sesion) {
      const destino = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/login.html?destino=${destino}`;
      return null;
    }
    return sesion;
  },

  // Valida usuario/contraseña contra el fichero de usuarios
  async validar(usuario, contrasena) {
    try {
      const resp = await fetch('/js/usuarios.json', { cache: 'no-store' });
      if (!resp.ok) throw new Error('No se pudo cargar la base de usuarios');
      const data = await resp.json();
      const registro = (data.usuarios || []).find(
        u => u.usuario.toLowerCase() === usuario.toLowerCase()
      );
      if (!registro) return { ok: false, error: 'Usuario o contraseña incorrectos' };
      const hashIntroducido = await this.hash(contrasena);
      if (hashIntroducido !== registro.hash) {
        return { ok: false, error: 'Usuario o contraseña incorrectos' };
      }
      return { ok: true, usuario: registro.usuario };
    } catch (err) {
      console.error(err);
      return { ok: false, error: 'Error al validar. Inténtalo de nuevo.' };
    }
  },
};

// Pinta la barra de usuario en la cabecera si hay sesión
function pintarUsuarioEnCabecera() {
  const hueco = document.getElementById('usuario-cabecera');
  if (!hueco) return;
  const sesion = AuthSession.get();
  if (!sesion) return;
  hueco.innerHTML = `
    <span>${sesion.usuario}</span>
    <button type="button" id="btn-logout">Salir</button>
  `;
  document.getElementById('btn-logout').addEventListener('click', () => AuthSession.logout());
}

document.addEventListener('DOMContentLoaded', pintarUsuarioEnCabecera);
