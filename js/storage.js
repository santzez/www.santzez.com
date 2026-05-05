/* =============================================================
   storage.js — Persistencia del progreso en Supabase
   -------------------------------------------------------------
   Sustituye al storage antiguo basado en localStorage. Toda la
   API es ahora asincrona. Usa el mismo cliente Supabase que
   crea AuthSession (auth.js).

   Tablas implicadas (ver recursos/supabase/setup.sql):
   - sesiones_quiz: una fila por tanda completada
   - intentos:       una fila por respuesta a pregunta
   ============================================================= */

const Storage = {
  cliente() { return AuthSession.cliente(); },

  /**
   * Guarda el resumen de una tanda de quiz.
   * resumen: { ope, tema, total, aciertos, fallos, porcentaje, modo }
   */
  async guardarSesion(usuarioId, resumen) {
    const { error } = await this.cliente().from('sesiones_quiz').insert({
      usuario_id: usuarioId,
      ope_id: resumen.ope,
      tema_id: resumen.tema,
      modo: resumen.modo || 'todas',
      total: resumen.total,
      aciertos: resumen.aciertos,
      fallos: resumen.fallos,
      porcentaje: resumen.porcentaje
    });
    if (error) console.error('Error guardando sesion:', error);
  },

  /** Registra el intento de una pregunta concreta. */
  async guardarIntento(usuarioId, preguntaId, acertada) {
    const { error } = await this.cliente().from('intentos').insert({
      usuario_id: usuarioId,
      pregunta_id: preguntaId,
      acertada: !!acertada
    });
    if (error) console.error('Error guardando intento:', error);
  },

  /**
   * Devuelve los IDs de preguntas (de las pasadas en preguntasDelTema)
   * cuyo numero de fallos del usuario es mayor al de aciertos.
   */
  async preguntasFalladas(usuarioId, preguntasDelTema) {
    const ids = preguntasDelTema.map(p => p.id);
    if (ids.length === 0) return [];
    const { data, error } = await this.cliente()
      .from('intentos')
      .select('pregunta_id, acertada')
      .eq('usuario_id', usuarioId)
      .in('pregunta_id', ids);
    if (error) { console.error(error); return []; }

    const stats = {};
    for (const intento of (data || [])) {
      const s = stats[intento.pregunta_id] || (stats[intento.pregunta_id] = { ac: 0, fa: 0 });
      if (intento.acertada) s.ac++; else s.fa++;
    }
    return Object.entries(stats)
      .filter(([, s]) => s.fa > s.ac)
      .map(([id]) => id);
  },

  /** Devuelve estadisticas globales acumuladas del usuario. */
  async estadisticas(usuarioId) {
    const { data, error } = await this.cliente()
      .from('sesiones_quiz')
      .select('aciertos, fallos, total')
      .eq('usuario_id', usuarioId);
    if (error) { console.error(error); return null; }

    const stats = (data || []).reduce((acc, s) => ({
      aciertos: acc.aciertos + s.aciertos,
      fallos:   acc.fallos   + s.fallos,
      total:    acc.total    + s.total,
      sesiones: acc.sesiones + 1
    }), { aciertos: 0, fallos: 0, total: 0, sesiones: 0 });

    stats.porcentaje = stats.total > 0 ? Math.round((stats.aciertos / stats.total) * 100) : 0;
    return stats;
  }
};
