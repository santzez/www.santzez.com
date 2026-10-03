/* =============================================================
   examen-sim.js — Simulacro de examen por apartados
   -------------------------------------------------------------
   API:
     ExamenSim.montar({ contenedor, datos })

   `datos` es el JSON del examen (vive en el bucket privado de
   Supabase, no en el repo). Cada apartado es:
     - tipo "test":       preguntas con 4 opciones; nota automática
                          con P = A − E/4 y la plantilla oficial.
     - tipo "desarrollo": respuesta libre; Claude corrige pregunta a
                          pregunta con los criterios del tribunal.

   Flujo: los apartados se listan como desplegables independientes
   (contraídos muestran el progreso). Al desplegar uno → "Empezar" →
   preguntas con temporizador → "Terminar" (o fin del tiempo) →
   corrección + campo para pedir algo a Claude. Con los tres
   terminados aparece el resultado global.

   El progreso se guarda en localStorage: si recargas, el examen y
   los temporizadores siguen donde estaban. Cada apartado corregido
   queda además en Supabase (tabla simulacros_intentos) para el
   historial de intentos.
   ============================================================= */

(function () {
  const esc = (t) => String(t ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString('es-ES');
  const textoDeHtml = (html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('p, li, tr, h3, h4').forEach(el => el.insertAdjacentText('afterend', '\n'));
    doc.querySelectorAll('td, th').forEach(el => el.insertAdjacentText('afterend', ' | '));
    return doc.body.textContent.replace(/\n{3,}/g, '\n\n').trim();
  };

  // ---------- Estado persistente ----------
  function crearAlmacen(idExamen) {
    const clave = 'santzez:examen:' + idExamen;
    let estado;
    try { estado = JSON.parse(localStorage.getItem(clave)) || null; } catch { estado = null; }
    if (!estado) estado = { apartados: {}, abiertos: [] };
    return {
      estado,
      guardar() { try { localStorage.setItem(clave, JSON.stringify(estado)); } catch {} },
      reiniciar() { try { localStorage.removeItem(clave); } catch {} },
      apartado(id) {
        return estado.apartados[id] || (estado.apartados[id] = { inicio: null, fin: null, respuestas: {}, notas: {}, claude: [] });
      },
    };
  }

  // ---------- Corrección del test ----------
  function corregirTest(ap, st) {
    let A = 0, E = 0, B = 0;
    ap.preguntas.forEach((q, i) => {
      const r = st.respuestas[i];
      if (r === undefined || r === null || r === '') B++;
      else if (Number(r) === q.correcta) A++;
      else E++;
    });
    return { A, E, B, nota: Math.max(0, A - E / 4) };
  }

  // ---------- Contexto para Claude ----------
  function contextoApartado(ap, st, datos) {
    const partes = [`Simulacro: ${datos.titulo}`, `Apartado: ${ap.titulo} (máximo ${ap.maximo} puntos)`, ap.descripcion];
    if (ap.enunciadoHtml) partes.push('ENUNCIADO DEL CASO:\n' + textoDeHtml(ap.enunciadoHtml));
    ap.preguntas.forEach((q, i) => {
      if (ap.tipo === 'test') {
        const r = st.respuestas[i];
        const mia = (r === undefined || r === null || r === '') ? 'en blanco' : 'abcd'[r];
        partes.push(`${q.n}. ${textoDeHtml(q.enunciado)}\n` +
          q.opciones.map((o, k) => `  ${'abcd'[k]}) ${textoDeHtml(o)}`).join('\n') +
          `\n  Correcta (plantilla oficial): ${'abcd'[q.correcta]} · Mi respuesta: ${mia}` +
          (q.nota ? `\n  Nota: ${q.nota}` : ''));
      } else {
        partes.push(`PREGUNTA ${i + 1} (${q.puntos} puntos): ${textoDeHtml(q.html || q.enunciado)}\n` +
          `Criterios del tribunal: ${q.criterios}\n` +
          `MI RESPUESTA:\n${(st.respuestas[i] || '').trim() || '(en blanco)'}`);
      }
    });
    return partes.join('\n\n');
  }

  function contextoPregunta(ap, q, i, st) {
    const partes = [`Apartado: ${ap.titulo}`];
    if (ap.enunciadoHtml) partes.push('ENUNCIADO DEL CASO:\n' + textoDeHtml(ap.enunciadoHtml));
    partes.push(`PREGUNTA (${q.puntos} puntos): ${textoDeHtml(q.html || q.enunciado)}`);
    partes.push(`CRITERIOS DE CORRECCIÓN DEL TRIBUNAL: ${q.criterios}`);
    partes.push(`RESPUESTA DEL ASPIRANTE:\n${(st.respuestas[i] || '').trim()}`);
    return partes.join('\n\n');
  }

  const PROMPT_CORREGIR = (q) =>
    `Actúa como tribunal de la oposición y corrige la RESPUESTA DEL ASPIRANTE a esta pregunta ` +
    `aplicando estrictamente los CRITERIOS DE CORRECCIÓN DEL TRIBUNAL. Sé breve y concreto: ` +
    `qué elementos puntúan y cuánto, qué falta o es erróneo para la nota máxima y cómo mejorarla. ` +
    `Termina SIEMPRE con una última línea exacta con este formato: NOTA: x/${q.puntos} ` +
    `(x con decimales si hace falta, sin pasar de ${q.puntos}).`;

  const extraerNota = (texto, max) => {
    const m = texto.match(/NOTA:\s*\**\s*([\d]+(?:[.,]\d+)?)/i);
    if (!m) return null;
    return Math.min(max, Math.max(0, parseFloat(m[1].replace(',', '.'))));
  };

  // =============================================================
  window.ExamenSim = {
    montar({ contenedor, datos }) {
      const cliente = AuthSession.cliente();
      const alm = crearAlmacen(datos.id);
      const est = alm.estado;
      let tic = null;

      contenedor.classList.add('examen');

      // ---------- Historial en Supabase ----------
      // Una fila por apartado corregido; si se vuelve a corregir, se
      // actualiza la misma fila (st.registroId).
      async function registrarIntento(ap, st) {
        const nota = notaApartado(ap);
        if (nota === null) return;
        const respondidas = ap.preguntas.filter((_, i) => {
          const r = st.respuestas[i];
          return ap.tipo === 'test' ? (r !== undefined && r !== null && r !== '') : !!String(r || '').trim();
        }).length;
        const fila = {
          examen_id: datos.id, apartado_id: ap.id, nota, maximo: ap.maximo,
          segundos: Math.round((Math.min(st.fin, st.inicio + ap.minutos * 60000) - st.inicio) / 1000),
          respondidas, total: ap.preguntas.length,
          detalle: { respuestas: st.respuestas, notas: Object.fromEntries(Object.entries(st.notas).map(([k, v]) => [k, v?.nota ?? null])) },
        };
        try {
          const tabla = cliente.from('simulacros_intentos');
          const { data, error } = st.registroId
            ? await tabla.update(fila).eq('id', st.registroId).select('id').single()
            : await tabla.insert(fila).select('id').single();
          if (error) throw error;
          st.registroId = data.id;
          alm.guardar();
          cargarHistorial();
        } catch (e) {
          console.warn('No se pudo guardar el intento en el historial:', e.message || e);
        }
      }

      let historial = null;   // null = cargando / no disponible
      async function cargarHistorial() {
        try {
          const { data, error } = await cliente.from('simulacros_intentos')
            .select('id, apartado_id, nota, maximo, segundos, respondidas, total, fecha')
            .eq('examen_id', datos.id).order('fecha', { ascending: false }).limit(200);
          if (error) throw error;
          historial = data || [];
        } catch { historial = null; }
        const nodo = contenedor.querySelector('.examen__historial');
        if (nodo) nodo.replaceWith(pintarHistorial());
      }

      function pintarHistorial() {
        const det = document.createElement('details');
        det.className = 'examen__historial';
        det.open = abierto('__historial');
        det.addEventListener('toggle', () => fijarAbierto('__historial', det.open));
        if (!historial || historial.length === 0) {
          det.innerHTML = `<summary>Historial de intentos</summary>
            <p class="examen__nota-pie">${historial ? 'Aún no hay intentos corregidos. Cada apartado que termines y corrijas quedará guardado aquí.' : 'Cargando…'}</p>`;
          if (!historial) det.hidden = true;
          return det;
        }
        const mmss = (s) => s == null ? '—' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        const fecha = (f) => new Date(f).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
        const bloques = datos.apartados.map(ap => {
          const filas = historial.filter(h => h.apartado_id === ap.id);
          if (!filas.length) return '';
          const notas = filas.map(h => Number(h.nota));
          const media = notas.reduce((a, b) => a + b, 0) / notas.length;
          return `
            <h4 class="examen__historial-titulo">${esc(ap.titulo)} · ${filas.length} intento${filas.length > 1 ? 's' : ''} ·
              media ${fmt(media)} · mejor ${fmt(Math.max(...notas))} / ${ap.maximo}</h4>
            <div class="tabla-wrap"><table class="tabla-tema examen__historial-tabla">
              <thead><tr><th>Fecha</th><th>Nota</th><th>Tiempo</th><th>Respondidas</th></tr></thead>
              <tbody>${filas.map(h => `<tr>
                <td>${fecha(h.fecha)}</td>
                <td><strong>${fmt(Number(h.nota))}</strong> / ${fmt(Number(h.maximo))}${ap.minimo ? (Number(h.nota) >= ap.minimo ? ' ✅' : ' ❌') : ''}</td>
                <td>${mmss(h.segundos)} / ${ap.minutos}:00</td>
                <td>${h.respondidas ?? '—'}/${h.total ?? ap.preguntas.length}</td></tr>`).join('')}</tbody>
            </table></div>`;
        }).join('');
        det.innerHTML = `<summary>Historial de intentos (${historial.length})</summary>${bloques}`;
        return det;
      }

      const notaApartado = (ap) => {
        const st = alm.apartado(ap.id);
        if (!st.fin) return null;
        if (ap.tipo === 'test') return corregirTest(ap, st).nota;
        const ns = ap.preguntas.map((_, i) => st.notas[i]?.nota);
        return ns.every(n => typeof n === 'number') ? ns.reduce((a, b) => a + b, 0) : null;
      };

      // Apartados desplegados (se recuerda al recargar)
      if (!Array.isArray(est.abiertos)) est.abiertos = [];
      const abierto = (id) => est.abiertos.includes(id);
      const fijarAbierto = (id, si) => {
        est.abiertos = est.abiertos.filter(x => x !== id);
        if (si) est.abiertos.push(id);
        alm.guardar();
      };

      function pintar() {
        clearInterval(tic);
        contenedor.innerHTML = '';
        contenedor.appendChild(pintarCabecera());
        contenedor.appendChild(pintarHistorial());
        for (const ap of datos.apartados) contenedor.appendChild(pintarApartado(ap, alm.apartado(ap.id)));
        if (datos.apartados.every(ap => alm.apartado(ap.id).fin)) contenedor.appendChild(pintarResumen());
        arrancarReloj();
      }

      // ---------- Cabecera ----------
      function pintarCabecera() {
        const div = document.createElement('section');
        div.className = 'examen__cabecera';
        const total = datos.apartados.reduce((s, a) => s + a.minutos, 0);
        const hayProgreso = datos.apartados.some(ap => alm.apartado(ap.id).inicio);
        div.innerHTML = `
          <div class="examen__titulo">${esc(datos.titulo)}</div>
          <p class="examen__nota-pie">Elige el apartado que quieras hacer; cada uno tiene su propio tiempo
            (${total} min en total, orientativos). ${datos.notaA ? esc(datos.notaA) : ''}</p>
          ${hayProgreso ? '<div class="examen__acciones"><button type="button" class="btn btn--secundario btn--pequeno" data-accion="reiniciar">Reiniciar simulacro</button></div>' : ''}`;
        div.querySelector('[data-accion="reiniciar"]')?.addEventListener('click', () => {
          if (!confirm('¿Reiniciar el simulacro completo? Se borrarán tus respuestas y correcciones de los tres apartados (el historial de intentos se conserva).')) return;
          alm.reiniciar();
          for (const k of Object.keys(est)) delete est[k];
          Object.assign(est, { apartados: {}, abiertos: [] });
          pintar();
        });
        return div;
      }

      // Resumen que se ve con el apartado contraído
      function textoProgreso(ap, st) {
        if (!st.inicio) return 'Sin empezar';
        const respondidas = ap.preguntas.filter((_, i) => {
          const r = st.respuestas[i];
          return ap.tipo === 'test' ? (r !== undefined && r !== null && r !== '') : !!String(r || '').trim();
        }).length;
        if (!st.fin) {
          const quedan = Math.max(0, Math.round((st.inicio + ap.minutos * 60000 - Date.now()) / 1000));
          return `En curso · quedan ${Math.floor(quedan / 60)}:${String(quedan % 60).padStart(2, '0')} · ${respondidas}/${ap.preguntas.length} respondidas`;
        }
        const n = notaApartado(ap);
        return n === null ? `Terminado · ${respondidas}/${ap.preguntas.length} respondidas · sin corregir` : `Nota ${fmt(n)} / ${ap.maximo}`;
      }

      // ---------- Un apartado (desplegable) ----------
      function pintarApartado(ap, st) {
        const det = document.createElement('details');
        det.className = 'examen__apartado' + (st.fin ? ' examen__apartado--terminado' : '') + (st.inicio && !st.fin ? ' examen__apartado--en-curso' : '');
        det.dataset.apartado = ap.id;
        det.open = abierto(ap.id);
        det.innerHTML = `
          <summary class="examen__cabeza">
            <span class="examen__cabeza-titulo">${esc(ap.titulo)}</span>
            <span class="examen__cabeza-meta">${ap.preguntas.length} preguntas · ${ap.minutos} min · ${ap.maximo} puntos${ap.minimo ? ` (mín. ${ap.minimo})` : ''}</span>
            <span class="examen__cabeza-progreso" data-progreso="${ap.id}">${textoProgreso(ap, st)}</span>
          </summary>
          <div class="examen__cuerpo"></div>`;
        det.addEventListener('toggle', () => fijarAbierto(ap.id, det.open));
        const cuerpo = det.querySelector('.examen__cuerpo');

        if (!st.inicio) {
          cuerpo.innerHTML = `
            <p class="examen__descripcion">${esc(ap.descripcion)}</p>
            <div class="examen__acciones"><button type="button" class="btn">Empezar ${esc(ap.titulo)} · ${ap.minutos} min</button></div>`;
          cuerpo.querySelector('button').addEventListener('click', () => {
            st.inicio = Date.now();
            fijarAbierto(ap.id, true);
            pintar();
            contenedor.querySelector(`[data-apartado="${ap.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
          return det;
        }

        cuerpo.innerHTML = `
          <div class="examen__barra">
            <div class="examen__barra-titulo">${esc(ap.titulo)}</div>
            <div class="examen__reloj" data-reloj="${ap.id}"></div>
          </div>
          <p class="examen__descripcion">${esc(ap.descripcion)}</p>
          ${ap.enunciadoHtml ? `<details class="examen__enunciado" open><summary>Enunciado del caso</summary><div class="tema-cuerpo">${ap.enunciadoHtml}</div></details>` : ''}
          <div class="examen__preguntas"></div>`;
        const lista = cuerpo.querySelector('.examen__preguntas');
        let fase = null;
        ap.preguntas.forEach((q, i) => {
          if (q.fase && q.fase !== fase) {
            fase = q.fase;
            lista.insertAdjacentHTML('beforeend', `<h3 class="examen__fase">${esc(fase)}</h3>`);
          }
          lista.appendChild(ap.tipo === 'test' ? pintarTest(ap, q, i, st) : pintarDesarrollo(ap, q, i, st));
        });
        if (!st.fin) {
          const fin = document.createElement('div');
          fin.className = 'examen__acciones';
          fin.innerHTML = `<button type="button" class="btn">Terminar ${esc(ap.titulo)}</button>`;
          fin.querySelector('button').addEventListener('click', () => {
            if (!confirm(`¿Terminar ${ap.titulo}? Ya no podrás cambiar tus respuestas.`)) return;
            terminar(ap);
          });
          cuerpo.appendChild(fin);
        } else {
          cuerpo.appendChild(pintarCorreccion(ap, st));
        }
        return det;
      }

      function pintarTest(ap, q, i, st) {
        const div = document.createElement('div');
        div.className = 'examen__pregunta';
        const r = st.respuestas[i];
        const hecha = !!st.fin;
        const opcion = (k, texto) => {
          let cls = '';
          if (hecha && k === q.correcta) cls = ' examen__opcion--correcta';
          else if (hecha && String(r) === String(k)) cls = ' examen__opcion--fallo';
          return `<label class="examen__opcion${cls}">
            <input type="radio" name="${ap.id}-${i}" value="${k}" ${String(r) === String(k) ? 'checked' : ''} ${hecha ? 'disabled' : ''}>
            <span><strong>${'abcd'[k]})</strong> ${texto}</span></label>`;
        };
        div.innerHTML = `
          <div class="examen__enunciado-pregunta"><strong>${q.n}.</strong> ${q.enunciado}</div>
          ${q.opciones.map((o, k) => opcion(k, o)).join('')}
          <label class="examen__opcion examen__opcion--blanco">
            <input type="radio" name="${ap.id}-${i}" value="" ${(r === undefined || r === '' || r === null) ? 'checked' : ''} ${hecha ? 'disabled' : ''}>
            <span>Dejar en blanco</span></label>
          ${hecha && q.nota ? `<p class="examen__aviso">${esc(q.nota)}</p>` : ''}`;
        div.addEventListener('change', (e) => {
          st.respuestas[i] = e.target.value === '' ? '' : Number(e.target.value);
          alm.guardar();
        });
        return div;
      }

      function pintarDesarrollo(ap, q, i, st) {
        const div = document.createElement('div');
        div.className = 'examen__pregunta';
        div.innerHTML = `
          <div class="examen__enunciado-pregunta">${q.html ? `<div class="tema-cuerpo">${q.html}</div>` : `<strong>${i + 1}.</strong> ${q.enunciado} <span class="examen__puntos">(${q.puntos} p)</span>`}</div>
          <textarea class="examen__texto" rows="${ap.enunciadoHtml ? 12 : 8}" placeholder="Escribe tu respuesta…" ${st.fin ? 'readonly' : ''}></textarea>
          ${st.fin ? `<p class="examen__criterios"><strong>Criterios del tribunal:</strong> ${esc(q.criterios)}</p><div class="examen__correccion-pregunta" data-pregunta="${i}"></div>` : ''}`;
        const ta = div.querySelector('textarea');
        ta.value = st.respuestas[i] || '';
        let t;
        ta.addEventListener('input', () => {
          st.respuestas[i] = ta.value;
          clearTimeout(t); t = setTimeout(() => alm.guardar(), 400);
        });
        if (st.fin) pintarNotaPregunta(div.querySelector('.examen__correccion-pregunta'), q, st.notas[i]);
        return div;
      }

      function pintarNotaPregunta(nodo, q, n) {
        if (!nodo) return;
        if (!n) { nodo.innerHTML = ''; return; }
        nodo.innerHTML = `
          <div class="examen__nota-pregunta">${typeof n.nota === 'number' ? `${fmt(n.nota)} / ${q.puntos}` : 'Sin nota'}</div>
          <div class="examen__claude">${ChatIA.markdown(n.texto || '')}</div>`;
      }

      function terminar(ap) {
        const st = alm.apartado(ap.id);
        if (st.fin) return;
        // Volcar lo escrito por si el último input no llegó a guardarse
        contenedor.querySelectorAll(`[data-apartado="${ap.id}"] textarea`).forEach((ta, i) => { st.respuestas[i] = ta.value; });
        st.fin = Date.now();
        alm.guardar();
        if (ap.tipo === 'test') registrarIntento(ap, st);
        pintar();
        contenedor.querySelector(`[data-apartado="${ap.id}"] .examen__correccion`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      // ---------- Corrección de un apartado ----------
      function pintarCorreccion(ap, st) {
        const div = document.createElement('div');
        div.className = 'examen__correccion tarjeta';
        if (ap.tipo === 'test') {
          const { A, E, B, nota } = corregirTest(ap, st);
          div.innerHTML = `
            <div class="examen__nota-grande">${fmt(nota)} <small>/ ${ap.maximo}</small></div>
            <p>${A} aciertos · ${E} errores · ${B} en blanco → P = ${A} − ${E}/4 = <strong>${fmt(nota)}</strong>. Corregido con la plantilla oficial.</p>`;
        } else {
          const n = notaApartado(ap);
          div.innerHTML = `
            <div class="examen__nota-grande">${n === null ? '—' : fmt(n)} <small>/ ${ap.maximo}</small></div>
            <p>Claude corrige cada pregunta con los criterios del tribunal. La nota es orientativa.</p>
            <div class="examen__acciones"><button type="button" class="btn" data-accion="corregir">${n === null ? 'Corregir y poner nota' : 'Volver a corregir'}</button></div>
            <p class="examen__progreso" hidden></p>`;
          div.querySelector('[data-accion="corregir"]').addEventListener('click', (e) => corregirDesarrollo(ap, st, e.target, div));
        }
        div.appendChild(pintarPreguntaLibre(ap, st));
        const rep = document.createElement('div');
        rep.className = 'examen__acciones';
        rep.innerHTML = `<button type="button" class="btn btn--secundario btn--pequeno">Repetir este apartado</button>`;
        rep.querySelector('button').addEventListener('click', () => {
          if (!confirm(`¿Repetir ${ap.titulo}? Se borrarán tus respuestas y la corrección de este apartado (el intento ya corregido se conserva en el historial).`)) return;
          delete est.apartados[ap.id];
          alm.guardar();
          pintar();
        });
        div.appendChild(rep);
        return div;
      }

      async function corregirDesarrollo(ap, st, boton, div) {
        boton.disabled = true;
        const prog = div.querySelector('.examen__progreso');
        prog.hidden = false;
        for (const [i, q] of ap.preguntas.entries()) {
          const nodo = contenedor.querySelector(`[data-apartado="${ap.id}"] [data-pregunta="${i}"]`);
          const resp = (st.respuestas[i] || '').trim();
          prog.textContent = `Corrigiendo pregunta ${i + 1} de ${ap.preguntas.length}…`;
          if (!resp) {
            st.notas[i] = { nota: 0, texto: 'Pregunta en blanco: 0 puntos.' };
            pintarNotaPregunta(nodo, q, st.notas[i]);
            alm.guardar();
            continue;
          }
          try {
            nodo.innerHTML = '<span class="chat-burbuja__spinner"></span>';
            const texto = await ChatIA.consultar({
              cliente, idTema: `${datos.id}-${ap.id}-${i + 1}`,
              pregunta: PROMPT_CORREGIR(q), contexto: contextoPregunta(ap, q, i, st), modo: 'corregir',
              onTexto: (t) => { nodo.innerHTML = `<div class="examen__claude">${ChatIA.markdown(t)}</div>`; },
            });
            st.notas[i] = { nota: extraerNota(texto, q.puntos), texto };
          } catch (e) {
            st.notas[i] = { nota: null, texto: '⚠ ' + e.message };
          }
          pintarNotaPregunta(nodo, q, st.notas[i]);
          alm.guardar();
        }
        registrarIntento(ap, st);
        pintar();
        contenedor.querySelector(`[data-apartado="${ap.id}"] .examen__correccion`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      // Campo libre para pedirle algo a Claude sobre el apartado
      function pintarPreguntaLibre(ap, st) {
        const div = document.createElement('div');
        div.className = 'examen__pregunta-libre';
        const sugerencia = ap.tipo === 'test'
          ? 'Explícame por qué fallé cada pregunta que no acerté y qué debo repasar.'
          : 'Dame una valoración global de este apartado y qué debo mejorar para el examen.';
        div.innerHTML = `
          <label class="examen__pregunta-libre-titulo">Pregúntale a Claude sobre este apartado</label>
          <div class="examen__conversacion">${st.claude.map(c =>
            `<div class="chat-burbuja chat-burbuja--user">${esc(c.p)}</div><div class="chat-burbuja chat-burbuja--assistant">${ChatIA.markdown(c.r)}</div>`).join('')}</div>
          <textarea rows="2" class="examen__texto">${esc(sugerencia)}</textarea>
          <div class="examen__acciones"><button type="button" class="btn btn--secundario">Enviar a Claude</button></div>`;
        const ta = div.querySelector('textarea');
        const btn = div.querySelector('button');
        const conv = div.querySelector('.examen__conversacion');
        btn.addEventListener('click', async () => {
          const p = ta.value.trim();
          if (p.length < 3) return;
          btn.disabled = true;
          conv.insertAdjacentHTML('beforeend', `<div class="chat-burbuja chat-burbuja--user">${esc(p)}</div>`);
          const burbuja = document.createElement('div');
          burbuja.className = 'chat-burbuja chat-burbuja--assistant';
          burbuja.innerHTML = '<span class="chat-burbuja__spinner"></span>';
          conv.appendChild(burbuja);
          try {
            const r = await ChatIA.consultar({
              cliente, idTema: `${datos.id}-${ap.id}`, pregunta: p.slice(0, 2000),
              contexto: contextoApartado(ap, st, datos), modo: 'corregir',
              onTexto: (t) => { burbuja.innerHTML = ChatIA.markdown(t); },
            });
            st.claude.push({ p, r });
            alm.guardar();
            ta.value = '';
          } catch (e) {
            burbuja.innerHTML = `<em class="chat-burbuja__error">⚠ ${esc(e.message)}</em>`;
          } finally {
            btn.disabled = false;
          }
        });
        return div;
      }

      // ---------- Resumen final ----------
      function pintarResumen() {
        const [aa, ab, b] = datos.apartados.map(notaApartado);
        const div = document.createElement('section');
        div.className = 'examen__resumen tarjeta';
        if ([aa, ab, b].some(n => n === null)) {
          div.innerHTML = '<p>Corrige todos los apartados para ver la nota final.</p>';
          return div;
        }
        const A = aa + ab;
        const okA = A >= 16, okB = b >= 15;
        const okT = !datos.minimoTotal || A + b >= datos.minimoTotal;
        div.innerHTML = `
          <div class="examen__titulo">Resultado del simulacro</div>
          <div class="tabla-wrap"><table class="tabla-tema"><tbody>
            <tr><td>Apartado A (test + cortas)</td><td><strong>${fmt(A)}</strong> / 40</td><td>${okA ? '✅' : '❌'} mínimo 16</td></tr>
            <tr><td>Apartado B (caso práctico)</td><td><strong>${fmt(b)}</strong> / 30</td><td>${okB ? '✅' : '❌'} mínimo 15</td></tr>
            <tr><td><strong>Total</strong></td><td><strong>${fmt(A + b)}</strong> / 70</td><td>${okA && okB && okT ? '✅ Aprobado' : '❌ No aprobado'}${datos.minimoTotal ? ` (mínimo ${datos.minimoTotal})` : ''}</td></tr>
          </tbody></table></div>
          <p class="examen__nota-pie">Hay que aprobar A y B por separado${datos.minimoTotal ? ` y sumar al menos ${datos.minimoTotal}` : ''}. Las notas de cortas y caso son orientativas (corregidas por Claude).</p>`;
        return div;
      }

      // ---------- Temporizador ----------
      function arrancarReloj() {
        const actualizar = () => {
          for (const ap of datos.apartados) {
            const st = alm.apartado(ap.id);
            if (!st.inicio) continue;
            const prog = contenedor.querySelector(`[data-progreso="${ap.id}"]`);
            if (prog) prog.textContent = textoProgreso(ap, st);
            const nodo = contenedor.querySelector(`[data-reloj="${ap.id}"]`);
            if (!nodo) {
              // Contraído: el tiempo sigue corriendo aunque no se vea el reloj
              if (!st.fin && Date.now() >= st.inicio + ap.minutos * 60000) {
                alert(`Se acabó el tiempo de ${ap.titulo}.`);
                terminar(ap);
                return;
              }
              continue;
            }
            const limite = st.inicio + ap.minutos * 60000;
            const fin = st.fin || Date.now();
            const quedan = Math.max(0, Math.round((limite - fin) / 1000));
            const usado = Math.round((Math.min(fin, limite) - st.inicio) / 1000);
            const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
            if (st.fin) {
              nodo.textContent = `Tiempo usado ${mmss(usado)}`;
              nodo.className = 'examen__reloj examen__reloj--parado';
            } else {
              nodo.textContent = mmss(quedan);
              nodo.className = 'examen__reloj' + (quedan <= 300 ? ' examen__reloj--aviso' : '');
              if (quedan === 0) {
                alert(`Se acabó el tiempo de ${ap.titulo}.`);
                terminar(ap);
                return;
              }
            }
          }
        };
        actualizar();
        tic = setInterval(actualizar, 1000);
      }

      pintar();
      cargarHistorial();
    },
  };
})();
