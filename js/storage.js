/* =============================================================
   storage.js — Capa de almacenamiento del progreso
   -------------------------------------------------------------
   Guarda los resultados de cada tanda del quiz y los intentos de
   cada pregunta. Encapsulado en una API simple para que, cuando
   se migre a Supabase/Firebase, sólo haya que sustituir el
   backend sin tocar el resto del código.
   ============================================================= */

const Storage = {
  LS_PROGRESO: 'oposizioak.progreso',

  _leer() {
    try {
      return JSON.parse(localStorage.getItem(this.LS_PROGRESO) || '{}');
    } catch {
      return {};
    }
  },

  _escribir(obj) {
    localStorage.setItem(this.LS_PROGRESO, JSON.stringify(obj));
  },

  // Obtiene (o crea) el "cuaderno" de un usuario
  _cuaderno(usuario) {
    const todo = this._leer();
    if (!todo[usuario]) todo[usuario] = { sesiones: [], intentos: {} };
    return { todo, cuaderno: todo[usuario] };
  },

  // Guarda una sesión completa de estudio (tanda de preguntas)
  guardarSesion(usuario, resumen) {
    const { todo, cuaderno } = this._cuaderno(usuario);
    cuaderno.sesiones.push({
      fecha: new Date().toISOString(),
      ...resumen,
    });
    // Limita el histórico a las 200 últimas sesiones
    if (cuaderno.sesiones.length > 200) {
      cuaderno.sesiones = cuaderno.sesiones.slice(-200);
    }
    this._escribir(todo);
  },

  // Guarda el intento de una pregunta (acierto/fallo)
  guardarIntento(usuario, preguntaId, acertada) {
    const { todo, cuaderno } = this._cuaderno(usuario);
    if (!cuaderno.intentos[preguntaId]) {
      cuaderno.intentos[preguntaId] = { aciertos: 0, fallos: 0, ultimo: null };
    }
    const reg = cuaderno.intentos[preguntaId];
    if (acertada) reg.aciertos++; else reg.fallos++;
    reg.ultimo = new Date().toISOString();
    this._escribir(todo);
  },

  // Devuelve los IDs de preguntas fallados por el usuario en un tema
  preguntasFalladas(usuario, preguntasDelTema) {
    const { cuaderno } = this._cuaderno(usuario);
    return preguntasDelTema
      .filter(p => {
        const i = cuaderno.intentos[p.id];
        return i && i.fallos > i.aciertos;
      })
      .map(p => p.id);
  },

  // Estadísticas globales del usuario
  estadisticas(usuario) {
    const { cuaderno } = this._cuaderno(usuario);
    const sesiones = cuaderno.sesiones;
    const totalSesiones = sesiones.length;
    const totalPreguntas = sesiones.reduce((s, x) => s + (x.total || 0), 0);
    const totalAciertos = sesiones.reduce((s, x) => s + (x.aciertos || 0), 0);
    return {
      totalSesiones,
      totalPreguntas,
      totalAciertos,
      porcentaje: totalPreguntas ? Math.round((totalAciertos / totalPreguntas) * 100) : 0,
      ultimaSesion: sesiones[sesiones.length - 1] || null,
    };
  },
};
