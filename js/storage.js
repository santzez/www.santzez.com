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
  },

  /**
   * Nº de intentos "completos" del tema: sesiones en modo 'todas' donde
   * total == totalPreguntas del tema (i.e. hiciste el quiz entero, sin
   * abandonar). Los repasos de fallos NO cuentan.
   */
  async intentosCompletos(usuarioId, opeRuta, temaId, totalPreguntas) {
    const { count, error } = await this.cliente()
      .from('sesiones_quiz')
      .select('*', { count: 'exact', head: true })
      .eq('usuario_id', usuarioId)
      .eq('ope_id', opeRuta)
      .eq('tema_id', temaId)
      .eq('modo', 'todas')
      .eq('total', totalPreguntas);
    if (error) { console.error('Error intentosCompletos:', error); return 0; }
    return count || 0;
  },

  /**
   * Borra todo el progreso de un tema del usuario actual:
   * - intentos: todas las respuestas a las preguntas del tema
   * - sesiones_quiz: todas las tandas del tema
   * preguntasIds: array de IDs de todas las preguntas del tema.
   */
  async borrarProgresoTema(usuarioId, opeRuta, temaId, preguntasIds) {
    const cli = this.cliente();
    // 1) Borrar intentos del usuario para esas preguntas
    if (preguntasIds && preguntasIds.length > 0) {
      const { error: e1 } = await cli.from('intentos')
        .delete()
        .eq('usuario_id', usuarioId)
        .in('pregunta_id', preguntasIds);
      if (e1) { console.error('Error borrando intentos:', e1); return { ok: false, motivo: e1.message }; }
    }
    // 2) Borrar sesiones del tema
    const { error: e2 } = await cli.from('sesiones_quiz')
      .delete()
      .eq('usuario_id', usuarioId)
      .eq('ope_id', opeRuta)
      .eq('tema_id', temaId);
    if (e2) { console.error('Error borrando sesiones:', e2); return { ok: false, motivo: e2.message }; }
    return { ok: true };
  }
};
