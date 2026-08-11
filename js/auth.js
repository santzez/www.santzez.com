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
   * Comprueba si el usuario actual es admin (columna es_admin en perfiles).
   * Cachea el resultado para toda la sesión JS.
   */
  _esAdminCache: undefined,
  async esAdmin() {
    if (this._esAdminCache !== undefined) return this._esAdminCache;
    const sesion = await this.getSesion();
    if (!sesion) { this._esAdminCache = false; return false; }
    const { data, error } = await this.cliente()
      .from('perfiles')
      .select('es_admin')
      .eq('id', sesion.user.id)
      .maybeSingle();
    if (error) { console.warn('No se pudo leer es_admin:', error); this._esAdminCache = false; return false; }
    this._esAdminCache = !!data && data.es_admin === true;
    return this._esAdminCache;
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

  /**
   * Pinta el bloque "usuario + iconos ajustes + salir" en la cabecera.
   * Estructura: [email] [⚙ ajustes] [⏻ salir]
   * El icono de ajustes abre un panel flotante con toggles de estilo.
   */
  async pintarUsuarioEnCabecera() {
    const cont = document.getElementById('usuario-cabecera');
    if (!cont) return;
    let usuario = null;
    try { usuario = await this.getUsuario(); } catch { /* sin sesion o sin config aun */ }
    if (!usuario) return;

    // Sincronizar preferencias con Supabase en background (silencioso)
    if (window.Preferencias?.sincronizarDesdeServidor) {
      Preferencias.sincronizarDesdeServidor();
    }

    // SVG iconos (Feather-style)
    const ICONO_ENGRANAJE = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    const ICONO_SALIR = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';
    const ICONO_USUARIOS = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';

    // Comprobar si es admin (para mostrar el icono de usuarios)
    const esAdmin = await this.esAdmin();

    cont.innerHTML = `
      <span class="cabecera__email">${usuario.email}</span>
      ${esAdmin ? `
      <button type="button" class="btn-icono" id="btn-usuarios" aria-label="Gestión de usuarios" title="Gestión de usuarios">
        ${ICONO_USUARIOS}
        <span class="btn-icono__badge" id="badge-pendientes" hidden></span>
      </button>` : ''}
      <button type="button" class="btn-icono" id="btn-ajustes" aria-label="Ajustes" title="Ajustes de estilo">
        ${ICONO_ENGRANAJE}
      </button>
      <button type="button" class="btn-icono" id="btn-salir" aria-label="Cerrar sesión" title="Cerrar sesión">
        ${ICONO_SALIR}
      </button>
      <div class="panel-ajustes" id="panel-ajustes" hidden>
        <div class="panel-ajustes__titulo">Ajustes de estilo</div>
        ${this._pintarToggle('quizFeedback', 'Quiz Feedback', 'Ripple, feedback verde/rojo, barra fluida, contador animado y confeti al ≥ 80%.')}
        ${this._pintarToggle('identidad', 'Identidad!', 'Gradiente animado en el header y logo con micro-bounce al hover.')}
        ${this._pintarToggle('viewTransitions', 'Antes muerta que sencilla', 'Transiciones nativas entre páginas. En navegadores viejos: sin efecto.')}
      </div>
      ${esAdmin ? `
      <div class="panel-usuarios" id="panel-usuarios" hidden>
        <div class="panel-ajustes__titulo">Gestión de usuarios</div>
        <div class="panel-usuarios__tabs">
          <button type="button" class="panel-usuarios__tab activo" data-tab="pendientes">
            Pendientes <span class="panel-usuarios__num" id="num-pendientes">·</span>
          </button>
          <button type="button" class="panel-usuarios__tab" data-tab="aprobados">
            Aprobados <span class="panel-usuarios__num" id="num-aprobados">·</span>
          </button>
        </div>
        <div class="panel-usuarios__contenido" id="usuarios-contenido">
          <p class="panel-usuarios__cargando">Cargando…</p>
        </div>
      </div>` : ''}
    `;

    // Estado inicial de los toggles
    const prefs = window.Preferencias ? Preferencias.get() : {};
    for (const clave of Object.keys(prefs)) {
      const input = cont.querySelector(`#toggle-${clave}`);
      if (input) input.checked = !!prefs[clave];
    }

    // Handlers
    cont.querySelector('#btn-salir').addEventListener('click', () => this.logout());

    const btnAjustes = cont.querySelector('#btn-ajustes');
    const panel = cont.querySelector('#panel-ajustes');
    btnAjustes.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
      btnAjustes.classList.toggle('activo', !panel.hidden);
    });

    // Cerrar panel al hacer clic fuera
    document.addEventListener('click', (e) => {
      if (panel.hidden) return;
      if (!panel.contains(e.target) && e.target !== btnAjustes) {
        panel.hidden = true;
        btnAjustes.classList.remove('activo');
      }
    });
    // Cerrar con Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) {
        panel.hidden = true;
        btnAjustes.classList.remove('activo');
      }
    });

    // Cambios de toggles → guardar y aplicar
    panel.querySelectorAll('input[type="checkbox"]').forEach(input => {
      input.addEventListener('change', () => {
        if (window.Preferencias) {
          Preferencias.set({ [input.dataset.clave]: input.checked });
        }
      });
    });

    // ============ PANEL DE GESTIÓN DE USUARIOS (solo admin) ============
    if (esAdmin) {
      const btnUsuarios = cont.querySelector('#btn-usuarios');
      const panelUsuarios = cont.querySelector('#panel-usuarios');
      let tabActiva = 'pendientes';
      let usuariosCache = null;

      // Cargar y renderizar
      const cargarUsuarios = async () => {
        const contenido = cont.querySelector('#usuarios-contenido');
        contenido.innerHTML = '<p class="panel-usuarios__cargando">Cargando…</p>';
        const { data, error } = await this.cliente().rpc('admin_listar_usuarios');
        if (error) {
          contenido.innerHTML = `<p class="panel-usuarios__error">Error: ${error.message}</p>`;
          return;
        }
        usuariosCache = data || [];
        actualizarContadores();
        renderTab();
      };

      const actualizarContadores = () => {
        const pend = usuariosCache.filter(u => !u.aprobado).length;
        const apro = usuariosCache.filter(u => u.aprobado).length;
        cont.querySelector('#num-pendientes').textContent = pend;
        cont.querySelector('#num-aprobados').textContent = apro;

        // Badge del icono en cabecera
        const badge = cont.querySelector('#badge-pendientes');
        if (pend > 0) {
          badge.textContent = pend;
          badge.hidden = false;
        } else {
          badge.hidden = true;
        }
      };

      const fmtFecha = iso => {
        if (!iso) return '—';
        const d = new Date(iso);
        return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
      };

      const renderTab = () => {
        const contenido = cont.querySelector('#usuarios-contenido');
        if (!usuariosCache) return;
        const lista = usuariosCache.filter(u => tabActiva === 'pendientes' ? !u.aprobado : u.aprobado);
        if (lista.length === 0) {
          contenido.innerHTML = `<p class="panel-usuarios__vacio">${tabActiva === 'pendientes' ? '✓ No hay solicitudes pendientes.' : 'Aún no hay usuarios aprobados.'}</p>`;
          return;
        }
        contenido.innerHTML = lista.map(u => `
          <div class="usuario-fila${u.es_admin ? ' usuario-fila--admin' : ''}" data-id="${u.id}">
            <div class="usuario-fila__info">
              <div class="usuario-fila__email">
                ${u.email}
                ${u.es_admin ? '<span class="usuario-fila__badge">admin</span>' : ''}
              </div>
              <div class="usuario-fila__meta">
                Registrado ${fmtFecha(u.created_at)}${u.last_sign_in ? ` · Último acceso ${fmtFecha(u.last_sign_in)}` : ''}
              </div>
            </div>
            <div class="usuario-fila__acciones">
              ${!u.aprobado ? `
                <button type="button" class="btn btn--acierto" data-accion="aprobar">✓ Aprobar</button>
                <button type="button" class="btn-icono usuario-fila__eliminar" data-accion="eliminar" title="Eliminar usuario">🗑</button>
              ` : `
                ${!u.es_admin ? `<button type="button" class="btn btn--secundario" data-accion="revocar">Revocar</button>` : ''}
              `}
            </div>
          </div>
        `).join('');

        // Handlers de cada fila
        contenido.querySelectorAll('.usuario-fila').forEach(fila => {
          const id = fila.dataset.id;
          fila.querySelector('[data-accion="aprobar"]')?.addEventListener('click', async () => {
            await cambiarAprobado(id, true);
          });
          fila.querySelector('[data-accion="revocar"]')?.addEventListener('click', async () => {
            if (!confirm('¿Revocar la aprobación de este usuario? Dejará de poder acceder hasta que lo vuelvas a aprobar.')) return;
            await cambiarAprobado(id, false);
          });
          fila.querySelector('[data-accion="eliminar"]')?.addEventListener('click', async () => {
            const email = fila.querySelector('.usuario-fila__email').textContent.trim();
            if (!confirm(`¿Eliminar definitivamente al usuario "${email}"? Se borra su cuenta y todos sus datos. Esta acción no se puede deshacer.`)) return;
            const { error } = await this.cliente().rpc('admin_eliminar_usuario', { user_id: id });
            if (error) return alert('Error: ' + error.message);
            await cargarUsuarios();
          });
        });
      };

      const cambiarAprobado = async (userId, nuevoEstado) => {
        const { error } = await this.cliente().rpc('admin_cambiar_aprobado', {
          user_id: userId, nuevo_estado: nuevoEstado
        });
        if (error) return alert('Error: ' + error.message);
        await cargarUsuarios();
      };

      // Handler tabs
      cont.querySelectorAll('.panel-usuarios__tab').forEach(t => {
        t.addEventListener('click', () => {
          tabActiva = t.dataset.tab;
          cont.querySelectorAll('.panel-usuarios__tab').forEach(x => x.classList.toggle('activo', x === t));
          renderTab();
        });
      });

      // Abrir / cerrar panel
      btnUsuarios.addEventListener('click', (e) => {
        e.stopPropagation();
        // Cerrar el otro panel si estaba abierto
        panel.hidden = true;
        btnAjustes.classList.remove('activo');
        panelUsuarios.hidden = !panelUsuarios.hidden;
        btnUsuarios.classList.toggle('activo', !panelUsuarios.hidden);
        if (!panelUsuarios.hidden) cargarUsuarios();
      });
      document.addEventListener('click', (e) => {
        if (panelUsuarios.hidden) return;
        if (!panelUsuarios.contains(e.target) && e.target !== btnUsuarios) {
          panelUsuarios.hidden = true;
          btnUsuarios.classList.remove('activo');
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !panelUsuarios.hidden) {
          panelUsuarios.hidden = true;
          btnUsuarios.classList.remove('activo');
        }
      });

      // Al abrir el panel de ajustes, cerrar el de usuarios (si estaba abierto)
      btnAjustes.addEventListener('click', () => {
        if (!panelUsuarios.hidden) {
          panelUsuarios.hidden = true;
          btnUsuarios.classList.remove('activo');
        }
      });

      // Cargar contadores al inicio (para el badge, aunque el panel esté cerrado)
      cargarUsuarios();
    }
  },

  _pintarToggle(clave, etiqueta, descripcion) {
    return `
      <label class="ajuste-toggle" for="toggle-${clave}">
        <div class="ajuste-toggle__texto">
          <div class="ajuste-toggle__etiqueta">${etiqueta}</div>
          <div class="ajuste-toggle__descripcion">${descripcion}</div>
        </div>
        <div class="ajuste-toggle__switch">
          <input type="checkbox" id="toggle-${clave}" data-clave="${clave}" />
          <span class="ajuste-toggle__slider"></span>
        </div>
      </label>
    `;
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
