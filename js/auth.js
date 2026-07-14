/* =============================================================
   auth.js — Autenticación contra Supabase
   -------------------------------------------------------------
   Reemplaza al sistema antiguo basado en usuarios.json + hash
   estático. Usa Supabase Auth (email/contraseña, recuperación
   de contraseña por email) + tabla `perfiles` con campo
   `aprobado` para que un nuevo registro NO pueda usar la web
   hasta que el administrador lo apruebe en el dashboard.
   ============================================================= */

const AuthSession = {
  _cliente: null,

  cliente() {
    if (!this._cliente) {
      if (typeof supabase === 'undefined' || !supabase.createClient) {
        throw new Error('No se ha cargado el cliente Supabase. Asegurate de que se carga supabase-js antes que auth.js.');
      }
      this._cliente = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return this._cliente;
  },

  /** Devuelve la sesion Supabase actual (incluye user) o null. */
  async getSesion() {
    const { data: { session } } = await this.cliente().auth.getSession();
    return session;
  },

  /** Devuelve {id, email} del usuario autenticado, o null. */
  async getUsuario() {
    const sesion = await this.getSesion();
    if (!sesion) return null;
    return { id: sesion.user.id, email: sesion.user.email };
  },

  /** Comprueba si el usuario actual tiene perfil con aprobado=true. */
  async aprobado() {
    const sesion = await this.getSesion();
    if (!sesion) return false;
    const { data, error } = await this.cliente()
      .from('perfiles')
      .select('aprobado')
      .eq('id', sesion.user.id)
      .maybeSingle();
    if (error) { console.warn('No se pudo leer el perfil:', error); return false; }
    return !!data && data.aprobado === true;
  },

  /**
   * Garantiza sesion activa Y aprobada antes de continuar.
   * - Sin sesion → redirige a /login.html
   * - Sesion no aprobada → redirige a /pendiente.html
   * - OK → devuelve un objeto con .user y .user.id
   */
  async exigirLogin() {
    const sesion = await this.getSesion();
    if (!sesion) {
      const destino = encodeURIComponent(location.pathname + location.search);
      location.href = `/login.html?destino=${destino}`;
      return null;
    }
    const aprobado = await this.aprobado();
    if (!aprobado) {
      location.href = '/pendiente.html';
      return null;
    }
    return { user: sesion.user };
  },

  /**
   * Envuelve una promesa con un timeout. Si el servidor no responde en
   * `ms` milisegundos, lanza un error que _traducirError() reconoce como
   * "Supabase caido".
   */
  _conTimeout(promesa, ms = 8000) {
    return Promise.race([
      promesa,
      new Promise((_, rej) => setTimeout(
        () => rej(new Error('Load failed')),
        ms
      ))
    ]);
  },

  /** Login con email + contraseña. */
  async iniciarSesion(email, contrasena) {
    try {
      const { data, error } = await this._conTimeout(this.cliente().auth.signInWithPassword({
        email: email.trim(),
        password: contrasena
      }));
      if (error) return { ok: false, error: this._traducirError(error) };
      return { ok: true, sesion: data.session };
    } catch (e) {
      return { ok: false, error: this._traducirError(e) };
    }
  },

  /** Registro de un usuario nuevo. Supabase enviara correo de confirmacion. */
  async registrar(email, contrasena) {
    try {
      const { data, error } = await this._conTimeout(this.cliente().auth.signUp({
        email: email.trim(),
        password: contrasena,
        options: {
          emailRedirectTo: location.origin + '/login.html'
        }
      }));
      if (error) return { ok: false, error: this._traducirError(error) };
      return { ok: true, sesion: data.session };
    } catch (e) {
      return { ok: false, error: this._traducirError(e) };
    }
  },

  /** Solicita correo de recuperacion de contrasena. */
  async solicitarReset(email) {
    try {
      const { error } = await this._conTimeout(this.cliente().auth.resetPasswordForEmail(email.trim(), {
        redirectTo: location.origin + '/cambiar-contrasena.html'
      }));
      if (error) return { ok: false, error: this._traducirError(error) };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: this._traducirError(e) };
    }
  },

  /** Cambia la contrasena del usuario logueado actualmente. */
  async cambiarContrasena(nueva) {
    try {
      const { error } = await this._conTimeout(this.cliente().auth.updateUser({ password: nueva }));
      if (error) return { ok: false, error: this._traducirError(error) };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: this._traducirError(e) };
    }
  },

  /** Cierra sesion y vuelve al login. */
  async logout() {
    try { await this.cliente().auth.signOut(); } catch {}
    location.href = '/login.html';
  },

  /** Pinta el bloque "usuario + boton salir" en la cabecera, si existe. */
  async pintarUsuarioEnCabecera() {
    const cont = document.getElementById('usuario-cabecera');
    if (!cont) return;
    let usuario = null;
    try { usuario = await this.getUsuario(); } catch { /* sin sesion o sin config aun */ }
    if (usuario) {
      cont.innerHTML = '';
      const span = document.createElement('span');
      span.style.cssText = 'opacity:0.85;margin-right:0.6rem';
      span.textContent = usuario.email;
      const btn = document.createElement('button');
      btn.className = 'btn btn--secundario';
      btn.type = 'button';
      btn.textContent = 'Salir';
      btn.addEventListener('click', () => this.logout());
      cont.appendChild(span);
      cont.appendChild(btn);
    }
  },

  _traducirError(error) {
    const m = (error && error.message) || '';
    const nombre = (error && error.name) || '';
    // Errores de red / servidor caído / timeout → mensaje humano
    if (
      m.includes('Load failed') ||
      m.includes('Failed to fetch') ||
      m.includes('NetworkError') ||
      m.toLowerCase().includes('network') ||
      m.toLowerCase().includes('timeout') ||
      m.toLowerCase().includes('timed out') ||
      m.includes('AbortError') ||
      nombre === 'AbortError' ||
      nombre === 'TypeError'
    ) {
      return 'Servicio no disponible temporalmente. Supabase caído. Es lo que tiene no pagar :)';
    }
    if (m.includes('Invalid login credentials')) return 'Email o contraseña incorrectos.';
    if (m.includes('Email not confirmed')) return 'Confirma tu email haciendo clic en el enlace que te hemos enviado.';
    if (m.includes('User already registered')) return 'Ya hay una cuenta con ese email. Prueba a iniciar sesión.';
    if (m.includes('Password should be at least')) return 'La contraseña debe tener al menos 6 caracteres.';
    if (m.includes('rate limit')) return 'Has hecho demasiados intentos. Espera unos minutos.';
    return m || 'Error desconocido.';
  }
};

window.addEventListener('DOMContentLoaded', () => {
  AuthSession.pintarUsuarioEnCabecera().catch(() => { /* silencio: en login no hay sesion */ });
});
