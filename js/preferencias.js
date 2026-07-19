/* =============================================================
   preferencias.js — Preferencias de estilo del usuario
   -------------------------------------------------------------
   Guarda tres flags on/off en user_metadata de Supabase y cachea
   en localStorage para evitar parpadeos al cargar.

   Preferencias:
     - quizFeedback     (Categoría B) → ripple + feedback + confetti + contador
     - identidad        (Categoría C) → gradiente header + bounce logo
     - viewTransitions  (Categoría D) → transiciones fluidas entre páginas

   Por defecto TODAS las preferencias están DESACTIVADAS.
   Se aplican como clases al <html>: anim-quiz-feedback, anim-identidad,
   anim-view-transitions.
   ============================================================= */

(function () {
  const CLAVE_LOCAL = 'santzez:preferencias';
  const DEFAULTS = {
    quizFeedback: false,
    identidad: false,
    viewTransitions: false,
  };

  const MAPA_CLASES = {
    quizFeedback: 'anim-quiz-feedback',
    identidad: 'anim-identidad',
    viewTransitions: 'anim-view-transitions',
  };

  // Lectura inmediata del cache local (síncrona) para evitar FOUC.
  function leerCache() {
    try {
      const raw = localStorage.getItem(CLAVE_LOCAL);
      if (!raw) return { ...DEFAULTS };
      const guardado = JSON.parse(raw);
      return { ...DEFAULTS, ...guardado };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function guardarCache(prefs) {
    try {
      localStorage.setItem(CLAVE_LOCAL, JSON.stringify(prefs));
    } catch {}
  }

  function aplicarClasesEnHtml(prefs) {
    const html = document.documentElement;
    for (const [clave, clase] of Object.entries(MAPA_CLASES)) {
      html.classList.toggle(clase, !!prefs[clave]);
    }
  }

  // --- APLICACIÓN INMEDIATA (antes del primer render) ---
  const cachePrefs = leerCache();
  aplicarClasesEnHtml(cachePrefs);

  // --- API pública ---
  window.Preferencias = {
    /** Devuelve las preferencias actuales (del cache local, síncrono). */
    get() {
      return leerCache();
    },

    /** Aplica un objeto parcial y persiste (local + Supabase si hay sesión). */
    async set(parciales) {
      const actuales = leerCache();
      const nuevas = { ...actuales, ...parciales };
      guardarCache(nuevas);
      aplicarClasesEnHtml(nuevas);
      // Persistencia remota (en background, best-effort)
      try {
        if (window.AuthSession) {
          const cliente = AuthSession.cliente();
          const { data: { session } } = await cliente.auth.getSession();
          if (session) {
            await cliente.auth.updateUser({ data: { preferencias: nuevas } });
          }
        }
      } catch (e) {
        console.warn('No se pudo persistir preferencias en Supabase:', e);
      }
      return nuevas;
    },

    /**
     * Sincroniza desde Supabase (por si el usuario cambió prefs en otro
     * dispositivo). Se llama tras tener la sesión disponible.
     * Si Supabase tiene datos, gana sobre el cache local.
     */
    async sincronizarDesdeServidor() {
      try {
        if (!window.AuthSession) return;
        const cliente = AuthSession.cliente();
        const { data: { session } } = await cliente.auth.getSession();
        if (!session) return;
        const remotas = session.user?.user_metadata?.preferencias;
        if (remotas && typeof remotas === 'object') {
          const combinadas = { ...DEFAULTS, ...remotas };
          guardarCache(combinadas);
          aplicarClasesEnHtml(combinadas);
        }
      } catch (e) {
        console.warn('No se pudo sincronizar preferencias:', e);
      }
    },

    /** Utilidad: lista de claves conocidas. */
    claves() {
      return Object.keys(DEFAULTS);
    },
  };
})();
