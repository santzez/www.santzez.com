/* =============================================================
   quiz-engine.js — Motor del quiz
   -------------------------------------------------------------
   Lee los parámetros de la URL (?ope=...&tema=...&modo=...),
   carga el JSON de preguntas, las mezcla, las va presentando una
   a una con feedback inmediato y al terminar muestra el resumen
   con gráfico (Chart.js) y las opciones de repetir.
   ============================================================= */

(async function () {
  const sesion = await AuthSession.exigirLogin();
  if (!sesion) return;
  const usuarioId = sesion.user.id;

  // Parámetros de URL
  const params = new URLSearchParams(window.location.search);
  const opeId = params.get('ope');
  const temaId = params.get('tema');
  // modo: 'todas' | 'falladas' — qué preguntas cargar
  const modo = params.get('modo') || 'todas';

  if (!opeId || !temaId) {
    document.getElementById('quiz-raiz').innerHTML =
      '<p class="mensaje-error visible">Falta la referencia de oposición o tema.</p>';
    return;
  }

  // Estado del quiz
  const estado = {
    preguntas: [],
    indice: 0,
    aciertos: 0,
    fallos: 0,
    falladasIds: [],
    infoTema: null,
  };

  // ------- Utilidades -------
  const barajar = arr => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const letra = i => String.fromCharCode(97 + i); // 0 -> a, 1 -> b...

  // ------- Carga de datos -------
  async function cargarTema() {
    const ruta = `data/${opeId}/${temaId}.json`;
    const resp = await fetch(ruta, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`No se pudo cargar ${ruta}`);
    return resp.json();
  }

  async function iniciar() {
    try {
      const datos = await cargarTema();
      estado.infoTema = datos;

      let pool = datos.preguntas;

      // Filtro por modo "falladas"
      if (modo === 'falladas') {
        const falladas = await Storage.preguntasFalladas(usuarioId, pool);
        pool = pool.filter(p => falladas.includes(p.id));
        if (pool.length === 0) {
          document.getElementById('quiz-raiz').innerHTML = `
            <div class="resultados">
              <h2>¡No hay preguntas falladas!</h2>
              <p class="resultados__detalle">Todavía no has fallado ninguna pregunta de este tema o ya las has recuperado.</p>
              <div class="resultados__acciones">
                <a class="btn" href="quiz.html?ope=${opeId}&tema=${temaId}">Hacer el tema completo</a>
                <a class="btn btn--secundario" href="ope.html?ope=${opeId}">Volver</a>
              </div>
            </div>`;
          return;
        }
      }

      // Mezcla las preguntas y las opciones dentro de cada pregunta
      estado.preguntas = barajar(pool).map(p => ({
        ...p,
        opcionesMezcladas: barajar(p.opciones),
      }));

      // Cabecera del quiz
      document.getElementById('quiz-titulo').textContent =
        `${datos.opeNombre || opeId} · ${datos.titulo || temaId}`;

      renderizarPregunta();
    } catch (err) {
      console.error(err);
      document.getElementById('quiz-raiz').innerHTML =
        `<p class="mensaje-error visible">Error cargando el tema: ${err.message}</p>`;
    }
  }

  // ------- Render de una pregunta -------
  function renderizarPregunta() {
    const total = estado.preguntas.length;
    const i = estado.indice;
    const pregunta = estado.preguntas[i];
    if (!pregunta) return mostrarResultados();

    // Actualizar contador y barra
    document.getElementById('contador-texto').innerHTML =
      `Pregunta <strong>${i + 1}</strong> de ${total}`;
    document.getElementById('barra-relleno').style.width =
      `${(i / total) * 100}%`;

    const raiz = document.getElementById('quiz-raiz');
    raiz.innerHTML = `
      <article class="pregunta">
        <div class="pregunta__numero">Pregunta ${i + 1}</div>
        <p class="pregunta__enunciado"></p>
        <div class="opciones" role="list"></div>
        <div class="feedback" id="feedback">
          <div class="feedback__titulo" id="feedback-titulo"></div>
          <div id="feedback-texto"></div>
          <div class="feedback__bloque"><strong>Razonamiento</strong><span id="feedback-razonamiento"></span></div>
          <div class="feedback__bloque"><strong>Mnemotécnico</strong><span id="feedback-mnemo"></span></div>
        </div>
        <div class="quiz-acciones oculto" id="acciones">
          <button class="btn" id="btn-siguiente">
            ${i + 1 === total ? 'Ver resultados' : 'Siguiente pregunta'}
          </button>
        </div>
      </article>`;

    raiz.querySelector('.pregunta__enunciado').textContent = pregunta.pregunta;

    const contOp = raiz.querySelector('.opciones');
    pregunta.opcionesMezcladas.forEach((op, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'opcion';
      btn.dataset.correcta = op.correcta ? '1' : '0';
      btn.innerHTML = `
        <span class="opcion__letra">${letra(idx)}</span>
        <span>${op.texto}</span>`;
      btn.addEventListener('click', () => responder(btn, pregunta));
      contOp.appendChild(btn);
    });
  }

  // ------- Respuesta -------
  function responder(botonPulsado, pregunta) {
    const cont = botonPulsado.parentElement;
    const botones = [...cont.querySelectorAll('.opcion')];
    const acertada = botonPulsado.dataset.correcta === '1';

    botones.forEach(b => {
      b.disabled = true;
      if (b.dataset.correcta === '1') b.classList.add('opcion--acierto');
    });
    if (!acertada) botonPulsado.classList.add('opcion--error');

    // Registrar intento (fire-and-forget; los errores se loguean en consola)
    Storage.guardarIntento(usuarioId, pregunta.id, acertada);

    if (acertada) estado.aciertos++;
    else {
      estado.fallos++;
      estado.falladasIds.push(pregunta.id);
    }

    // Feedback
    const fb = document.getElementById('feedback');
    fb.classList.remove('feedback--acierto', 'feedback--error');
    fb.classList.add(acertada ? 'feedback--acierto' : 'feedback--error');
    fb.classList.add('visible');
    document.getElementById('feedback-titulo').textContent =
      acertada ? '✓ Correcta' : '✗ Incorrecta';
    document.getElementById('feedback-razonamiento').textContent =
      pregunta.razonamiento || '—';
    document.getElementById('feedback-mnemo').textContent =
      pregunta.mnemotecnico || '—';

    // Mostrar botón siguiente
    document.getElementById('acciones').classList.remove('oculto');
    document.getElementById('btn-siguiente').addEventListener('click', siguiente, { once: true });
  }

  function siguiente() {
    estado.indice++;
    if (estado.indice >= estado.preguntas.length) {
      mostrarResultados();
    } else {
      renderizarPregunta();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  // ------- Pantalla de resultados -------
  function mostrarResultados() {
    const total = estado.preguntas.length;
    const aciertos = estado.aciertos;
    const fallos = estado.fallos;
    const porcentaje = Math.round((aciertos / total) * 100);

    // Guardar la sesión (fire-and-forget)
    Storage.guardarSesion(usuarioId, {
      ope: opeId,
      tema: temaId,
      total,
      aciertos,
      fallos,
      porcentaje,
      modo,
    });

    // Ocultar barra
    document.getElementById('barra-relleno').style.width = '100%';
    document.getElementById('contador-texto').innerHTML =
      `Finalizado · <strong>${porcentaje}%</strong>`;

    const hayFalladas = estado.falladasIds.length > 0;

    document.getElementById('quiz-raiz').innerHTML = `
      <div class="resultados">
        <h2>Resultados</h2>
        <div class="resultados__nota">${aciertos}<span style="font-size:1.6rem;color:var(--color-texto-suave)">/${total}</span></div>
        <p class="resultados__detalle">Has acertado el <strong>${porcentaje}%</strong> de las preguntas.</p>

        <div class="resultados__grafico">
          <canvas id="grafico-resultados" width="360" height="360"></canvas>
        </div>

        <div class="mini-stats">
          <div class="mini-stat">
            <div class="mini-stat__valor" style="color:var(--color-acierto)">${aciertos}</div>
            <div class="mini-stat__etiqueta">Aciertos</div>
          </div>
          <div class="mini-stat">
            <div class="mini-stat__valor" style="color:var(--color-error)">${fallos}</div>
            <div class="mini-stat__etiqueta">Fallos</div>
          </div>
          <div class="mini-stat">
            <div class="mini-stat__valor">${total}</div>
            <div class="mini-stat__etiqueta">Total</div>
          </div>
        </div>

        <div class="resultados__acciones">
          ${hayFalladas
            ? `<a class="btn" href="quiz.html?ope=${opeId}&tema=${temaId}&modo=falladas">Repetir sólo falladas (${estado.falladasIds.length})</a>`
            : ''}
          <a class="btn ${hayFalladas ? 'btn--secundario' : ''}" href="quiz.html?ope=${opeId}&tema=${temaId}">Repetir todas</a>
          <a class="btn btn--secundario" href="ope.html?ope=${opeId}">Volver a los temas</a>
        </div>
      </div>`;

    // Pintar el donut
    const ctx = document.getElementById('grafico-resultados');
    // eslint-disable-next-line no-undef
    new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Aciertos', 'Fallos'],
        datasets: [{
          data: [aciertos, fallos],
          backgroundColor: ['#2e7d3c', '#c62828'],
          borderColor: '#ffffff',
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        cutout: '65%',
        plugins: {
          legend: { position: 'bottom', labels: { font: { family: 'Barlow, Arial' } } },
        },
      },
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  iniciar();
})();
