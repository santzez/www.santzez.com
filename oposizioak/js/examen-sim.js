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

   Flujo: resumen + "Empezar examen" → apartado 1 con temporizador →
   "Terminar apartado" (o fin del tiempo) → corrección + campo para
   pedir algo a Claude → "Iniciar siguiente apartado" → … → resumen.

   El progreso se guarda en localStorage: si recargas, el examen y
   los temporizadores siguen donde estaban.
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
    if (!estado) estado = { empezado: false, apartados: {} };
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
    `qué puntúa, qué falta para la nota máxima y una sugerencia de mejora. ` +
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

      const notaApartado = (ap) => {
        const st = alm.apartado(ap.id);
        if (!st.fin) return null;
        if (ap.tipo === 'test') return corregirTest(ap, st).nota;
        const ns = ap.preguntas.map((_, i) => st.notas[i]?.nota);
        return ns.every(n => typeof n === 'number') ? ns.reduce((a, b) => a + b, 0) : null;
      };

      function pintar() {
        clearInterval(tic);
        contenedor.innerHTML = '';
        contenedor.appendChild(pintarCabecera());
        if (!est.empezado) return;
        for (const [idx, ap] of datos.apartados.entries()) {
          const st = alm.apartado(ap.id);
          if (!st.inicio) {
            const prev = datos.apartados[idx - 1];
            if (prev && !alm.apartado(prev.id).fin) break;
            contenedor.appendChild(pintarBotonInicio(ap));
            break;
          }
          contenedor.appendChild(pintarApartado(ap, st));
          if (!st.fin) break;
        }
        if (datos.apartados.every(ap => alm.apartado(ap.id).fin)) contenedor.appendChild(pintarResumen());
        arrancarReloj();
      }

      // ---------- Cabecera con los apartados ----------
      function pintarCabecera() {
        const div = document.createElement('section');
        div.className = 'examen__cabecera tarjeta';
        const total = datos.apartados.reduce((s, a) => s + a.minutos, 0);
        div.innerHTML = `
          <div class="examen__titulo">${esc(datos.titulo)}</div>
          <ol class="examen__indice">
            ${datos.apartados.map(ap => {
              const st = alm.apartado(ap.id);
              const n = notaApartado(ap);
              const estado = st.fin ? (n === null ? 'Terminado' : `${fmt(n)} / ${ap.maximo}`) : (st.inicio ? 'En curso' : '');
              return `<li><span class="examen__indice-titulo">${esc(ap.titulo)}</span>
                <span class="examen__indice-meta">${ap.preguntas.length} preguntas · ${ap.minutos} min · ${ap.maximo} puntos</span>
                ${estado ? `<span class="examen__indice-estado">${estado}</span>` : ''}</li>`;
            }).join('')}
          </ol>
          <p class="examen__nota-pie">Tiempo total: ${Math.floor(total / 60)} h ${total % 60} min. Los tiempos son orientativos.
            ${datos.notaA ? esc(datos.notaA) : ''}</p>
          <div class="examen__acciones">
            ${est.empezado
              ? '<button type="button" class="btn btn--secundario btn--pequeno" data-accion="reiniciar">Reiniciar simulacro</button>'
              : '<button type="button" class="btn" data-accion="empezar">Empezar examen</button>'}
          </div>`;
        div.querySelector('[data-accion="empezar"]')?.addEventListener('click', () => {
          est.empezado = true;
          alm.apartado(datos.apartados[0].id).inicio = Date.now();
          alm.guardar();
          pintar();
          contenedor.querySelector('.examen__apartado')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        div.querySelector('[data-accion="reiniciar"]')?.addEventListener('click', () => {
          if (!confirm('¿Reiniciar el simulacro? Se borrarán tus respuestas y correcciones.')) return;
          alm.reiniciar();
          for (const k of Object.keys(est)) delete est[k];
          Object.assign(est, { empezado: false, apartados: {} });
          pintar();
        });
        return div;
      }

      function pintarBotonInicio(ap) {
        const div = document.createElement('div');
        div.className = 'examen__siguiente';
        div.innerHTML = `<button type="button" class="btn">Iniciar ${esc(ap.titulo)} · ${ap.minutos} min</button>`;
        div.querySelector('button').addEventListener('click', () => {
          alm.apartado(ap.id).inicio = Date.now();
          alm.guardar();
          pintar();
          contenedor.querySelector(`[data-apartado="${ap.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        return div;
      }

      // ---------- Un apartado ----------
      function pintarApartado(ap, st) {
        const sec = document.createElement('section');
        sec.className = 'examen__apartado' + (st.fin ? ' examen__apartado--terminado' : '');
        sec.dataset.apartado = ap.id;
        sec.innerHTML = `
          <header class="examen__barra">
            <div>
              <div class="examen__barra-titulo">${esc(ap.titulo)}</div>
              <div class="examen__barra-meta">${ap.maximo} puntos${ap.minimo ? ` · mínimo ${ap.minimo}` : ''}</div>
            </div>
            <div class="examen__reloj" data-reloj="${ap.id}"></div>
          </header>
          <p class="examen__descripcion">${esc(ap.descripcion)}</p>
          ${ap.enunciadoHtml ? `<details class="examen__enunciado" open><summary>Enunciado del caso</summary><div class="tema-cuerpo">${ap.enunciadoHtml}</div></details>` : ''}
          <div class="examen__preguntas"></div>`;
        const lista = sec.querySelector('.examen__preguntas');
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
          sec.appendChild(fin);
        } else {
          sec.appendChild(pintarCorreccion(ap, st));
        }
        return sec;
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
              pregunta: PROMPT_CORREGIR(q), contexto: contextoPregunta(ap, q, i, st),
              onTexto: (t) => { nodo.innerHTML = `<div class="examen__claude">${ChatIA.markdown(t)}</div>`; },
            });
            st.notas[i] = { nota: extraerNota(texto, q.puntos), texto };
          } catch (e) {
            st.notas[i] = { nota: null, texto: '⚠ ' + e.message };
          }
          pintarNotaPregunta(nodo, q, st.notas[i]);
          alm.guardar();
        }
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
              contexto: contextoApartado(ap, st, datos),
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
        div.innerHTML = `
          <div class="examen__titulo">Resultado del simulacro</div>
          <div class="tabla-wrap"><table class="tabla-tema"><tbody>
            <tr><td>Apartado A (test + cortas)</td><td><strong>${fmt(A)}</strong> / 40</td><td>${okA ? '✅' : '❌'} mínimo 16</td></tr>
            <tr><td>Apartado B (caso práctico)</td><td><strong>${fmt(b)}</strong> / 30</td><td>${okB ? '✅' : '❌'} mínimo 15</td></tr>
            <tr><td><strong>Total 2.º ejercicio</strong></td><td><strong>${fmt(A + b)}</strong> / 70</td><td>${okA && okB ? '✅ Aprobado' : '❌ No aprobado'}</td></tr>
          </tbody></table></div>
          <p class="examen__nota-pie">Hay que aprobar A y B por separado. Las notas de cortas y caso son orientativas (corregidas por Claude).</p>`;
        return div;
      }

      // ---------- Temporizador ----------
      function arrancarReloj() {
        const actualizar = () => {
          for (const ap of datos.apartados) {
            const st = alm.apartado(ap.id);
            const nodo = contenedor.querySelector(`[data-reloj="${ap.id}"]`);
            if (!nodo || !st.inicio) continue;
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
    },
  };
})();
