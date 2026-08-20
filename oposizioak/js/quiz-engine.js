/* =============================================================
   quiz-engine.js — Motor del quiz (API)
   -------------------------------------------------------------
   API pública:
     QuizEngine.iniciar(config)      → arranca un nuevo quiz
     QuizEngine.pausarCronometro()   → congela el reloj
     QuizEngine.reanudarCronometro() → sigue corriendo
     QuizEngine.destruir()           → limpia estado, useful si el usuario
                                       vuelve a la lista de temas

   config = {
     ope,              string  — ruta ope
     tema,             string  — tema id
     modo,             'todas' | 'falladas' (default 'todas')
     usuarioId,        string  — auth uid
     cont,             HTMLElement — contenedor principal del quiz
     titulo,           HTMLElement — donde escribir el título del quiz
     contador,         HTMLElement — donde escribir "Pregunta X de Y"
     barra,            HTMLElement — barra de progreso (el ancho)
     cronometro,       HTMLElement — display del cronómetro (opcional)
     alVolver,         function() — callback cuando el usuario pulsa "Volver a la lista"
                                    (opcional, si null se usan hrefs)
     alTerminar,       function() — callback al mostrar resultados (opcional)
   }
   ============================================================= */

(function () {
  // Estado interno (singleton — solo un quiz activo a la vez)
  let estado = null;

  // ---------------------- CRONÓMETRO ----------------------
  let crono = {
    inicio: null,       // Date.now() cuando arrancó/reanudó el cronómetro
    acumulado: 0,       // ms acumulados de tramos previos
    interval: null,
    pausado: true,
    display: null,      // HTMLElement donde escribir el tiempo
    detenido: false,    // true una vez terminado el quiz
  };

  function formatearTiempo(segundos) {
    const s = Math.max(0, Math.floor(segundos));
    const h = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
    const ss = (s % 60).toString().padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function tiempoActualMs() {
    return crono.acumulado + (crono.inicio ? Date.now() - crono.inicio : 0);
  }

  function pintarCronometro() {
    if (crono.display) {
      crono.display.textContent = formatearTiempo(tiempoActualMs() / 1000);
    }
  }

  function iniciarCronometro() {
    crono.acumulado = 0;
    crono.inicio = Date.now();
    crono.pausado = false;
    crono.detenido = false;
    pintarCronometro();
    if (crono.interval) clearInterval(crono.interval);
    crono.interval = setInterval(pintarCronometro, 500);
  }

  function pausarCronometro() {
    if (crono.detenido || crono.pausado) return;
    if (crono.inicio) {
      crono.acumulado += Date.now() - crono.inicio;
      crono.inicio = null;
    }
    crono.pausado = true;
    if (crono.display) crono.display.classList.add('cronometro--pausado');
  }

  function reanudarCronometro() {
    if (crono.detenido || !crono.pausado) return;
    crono.inicio = Date.now();
    crono.pausado = false;
    if (crono.display) crono.display.classList.remove('cronometro--pausado');
  }

  function detenerCronometro() {
    if (crono.inicio) {
      crono.acumulado += Date.now() - crono.inicio;
      crono.inicio = null;
    }
    if (crono.interval) clearInterval(crono.interval);
    crono.interval = null;
    crono.detenido = true;
    pintarCronometro();
    return Math.floor(crono.acumulado / 1000);
  }

  function resetearCronometro() {
    crono.inicio = null;
    crono.acumulado = 0;
    crono.pausado = true;
    crono.detenido = false;
    if (crono.interval) { clearInterval(crono.interval); crono.interval = null; }
    if (crono.display) {
      crono.display.textContent = '00:00';
      crono.display.classList.remove('cronometro--pausado');
    }
  }

  // ---------------------- UTILIDADES ----------------------
  const barajar = arr => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const letra = i => String.fromCharCode(97 + i);

  const feedbackAnimActivo = () =>
    document.documentElement.classList.contains('anim-quiz-feedback');

  function lanzarRipple(evt, botonPulsado) {
    if (!feedbackAnimActivo()) return;
    const rect = botonPulsado.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = (evt.clientX ?? (rect.left + rect.width / 2)) - rect.left - size / 2;
    const y = (evt.clientY ?? (rect.top + rect.height / 2)) - rect.top - size / 2;
    const span = document.createElement('span');
    span.className = 'ripple';
    span.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${size}px;`;
    botonPulsado.appendChild(span);
    setTimeout(() => span.remove(), 600);
  }

  function animarContador(nodo, valorFinal, duracionMs = 800) {
    if (!feedbackAnimActivo()) { nodo.textContent = valorFinal; return; }
    const inicioTs = performance.now();
    function paso(t) {
      const p = Math.min(1, (t - inicioTs) / duracionMs);
      const eased = 1 - Math.pow(1 - p, 3);
      nodo.textContent = Math.round(valorFinal * eased);
      if (p < 1) requestAnimationFrame(paso);
      else nodo.textContent = valorFinal;
    }
    requestAnimationFrame(paso);
  }

  let _confettiPromise = null;
  function cargarConfetti() {
    if (_confettiPromise) return _confettiPromise;
    _confettiPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js';
      s.onload = () => resolve(window.confetti);
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return _confettiPromise;
  }
  async function lanzarConfetti() {
    if (!feedbackAnimActivo()) return;
    try {
      const confetti = await cargarConfetti();
      if (!confetti) return;
      const colors = ['#003da5', '#2e7d3c', '#ffffff', '#5a5652'];
      const end = Date.now() + 1500;
      (function frame() {
        confetti({ particleCount: 3, angle: 60, spread: 55, origin: { x: 0, y: 0.85 }, colors });
        confetti({ particleCount: 3, angle: 120, spread: 55, origin: { x: 1, y: 0.85 }, colors });
        if (Date.now() < end) requestAnimationFrame(frame);
      })();
    } catch (e) { console.warn('No se pudo cargar canvas-confetti:', e); }
  }

  // ---------------------- MOTOR ----------------------
  async function iniciar(config) {
    // Limpieza previa por si había un quiz corriendo
    destruir();

    estado = {
      config,
      preguntas: [],
      indice: 0,
      aciertos: 0,
      fallos: 0,
      falladasIds: [],
      infoTema: null,
    };

    crono.display = config.cronometro || null;
    resetearCronometro();

    if (!config.ope || !config.tema) {
      config.cont.innerHTML = '<p class="mensaje-error visible">Falta la referencia de oposición o tema.</p>';
      return;
    }

    try {
      const ruta = `data/${config.ope}/${config.tema}.json`;
      const resp = await fetch(ruta, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`No se pudo cargar ${ruta}`);
      const datos = await resp.json();
      estado.infoTema = datos;

      let pool = datos.preguntas;
      const modo = config.modo || 'todas';

      if (modo === 'falladas') {
        const falladas = await Storage.preguntasFalladas(config.usuarioId, pool);
        pool = pool.filter(p => falladas.includes(p.id));
        if (pool.length === 0) {
          config.cont.innerHTML = `
            <div class="resultados">
              <h2>¡No hay preguntas falladas!</h2>
              <p class="resultados__detalle">Todavía no has fallado ninguna pregunta de este tema.</p>
              <div class="resultados__acciones">
                <button type="button" class="btn" data-accion="reiniciar-todas">Hacer el tema completo</button>
                <button type="button" class="btn btn--secundario" data-accion="volver">Volver a los temas</button>
              </div>
            </div>`;
          config.cont.querySelector('[data-accion="reiniciar-todas"]')
            .addEventListener('click', () => iniciar({ ...config, modo: 'todas' }));
          config.cont.querySelector('[data-accion="volver"]')
            .addEventListener('click', () => (config.alVolver ? config.alVolver() : history.back()));
          return;
        }
      }

      estado.preguntas = barajar(pool).map(p => ({
        ...p,
        opcionesMezcladas: barajar(p.opciones),
      }));

      if (config.titulo) {
        config.titulo.textContent = `${datos.opeNombre || config.ope} · ${datos.titulo || config.tema}`;
      }

      iniciarCronometro();
      renderizarPregunta();
    } catch (err) {
      console.error(err);
      config.cont.innerHTML = `<p class="mensaje-error visible">Error cargando el tema: ${err.message}</p>`;
    }
  }

  function renderizarPregunta() {
    const cfg = estado.config;
    const total = estado.preguntas.length;
    const i = estado.indice;
    const pregunta = estado.preguntas[i];
    if (!pregunta) return mostrarResultados();

    if (cfg.contador) {
      cfg.contador.innerHTML = `Pregunta <strong>${i + 1}</strong> de ${total}`;
    }
    if (cfg.barra) {
      cfg.barra.style.width = `${(i / total) * 100}%`;
    }

    cfg.cont.innerHTML = `
      <article class="pregunta">
        <div class="pregunta__numero">Pregunta ${i + 1}</div>
        <p class="pregunta__enunciado"></p>
        <div class="opciones" role="list"></div>
        <div class="feedback">
          <div class="feedback__titulo"></div>
          <div class="feedback__texto"></div>
          <div class="feedback__bloque"><strong>Razonamiento</strong><span class="feedback__razonamiento"></span></div>
          <div class="feedback__bloque"><strong>Mnemotécnico</strong><span class="feedback__mnemo"></span></div>
        </div>
        <div class="quiz-acciones oculto">
          <button class="btn" data-accion="siguiente">
            ${i + 1 === total ? 'Ver resultados' : 'Siguiente pregunta'}
          </button>
        </div>
      </article>`;

    cfg.cont.querySelector('.pregunta__enunciado').textContent = pregunta.pregunta;

    const contOp = cfg.cont.querySelector('.opciones');
    pregunta.opcionesMezcladas.forEach((op, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'opcion';
      btn.dataset.correcta = op.correcta ? '1' : '0';
      btn.innerHTML = `
        <span class="opcion__letra">${letra(idx)}</span>
        <span>${op.texto}</span>`;
      btn.addEventListener('click', (ev) => { lanzarRipple(ev, btn); responder(btn, pregunta); });
      contOp.appendChild(btn);
    });
  }

  function responder(botonPulsado, pregunta) {
    const cfg = estado.config;
    const cont = botonPulsado.parentElement;
    const botones = [...cont.querySelectorAll('.opcion')];
    const acertada = botonPulsado.dataset.correcta === '1';

    botones.forEach(b => {
      b.disabled = true;
      if (b.dataset.correcta === '1') b.classList.add('opcion--acierto');
    });
    if (!acertada) botonPulsado.classList.add('opcion--error');

    Storage.guardarIntento(cfg.usuarioId, pregunta.id, acertada);

    if (acertada) estado.aciertos++;
    else {
      estado.fallos++;
      estado.falladasIds.push(pregunta.id);
    }

    const fb = cfg.cont.querySelector('.feedback');
    fb.classList.remove('feedback--acierto', 'feedback--error');
    fb.classList.add(acertada ? 'feedback--acierto' : 'feedback--error');
    fb.classList.add('visible');
    cfg.cont.querySelector('.feedback__titulo').textContent = acertada ? '✓ Correcta' : '✗ Incorrecta';
    cfg.cont.querySelector('.feedback__razonamiento').textContent = pregunta.razonamiento || '—';
    cfg.cont.querySelector('.feedback__mnemo').textContent = pregunta.mnemotecnico || '—';

    const acciones = cfg.cont.querySelector('.quiz-acciones');
    acciones.classList.remove('oculto');
    acciones.querySelector('[data-accion="siguiente"]').addEventListener('click', siguiente, { once: true });
  }

  function siguiente() {
    estado.indice++;
    if (estado.indice >= estado.preguntas.length) {
      mostrarResultados();
    } else {
      renderizarPregunta();
      estado.config.cont.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function mostrarResultados() {
    const cfg = estado.config;
    const total = estado.preguntas.length;
    const aciertos = estado.aciertos;
    const fallos = estado.fallos;
    const porcentaje = Math.round((aciertos / total) * 100);
    const segundos = detenerCronometro();
    const tiempoLegible = formatearTiempo(segundos);

    Storage.guardarSesion(cfg.usuarioId, {
      ope: cfg.ope, tema: cfg.tema,
      total, aciertos, fallos, porcentaje,
      modo: cfg.modo || 'todas',
      tiempo_segundos: segundos,
    });

    if (cfg.barra) cfg.barra.style.width = '100%';
    if (cfg.contador) cfg.contador.innerHTML = `Finalizado · <strong>${porcentaje}%</strong>`;

    const hayFalladas = estado.falladasIds.length > 0;

    cfg.cont.innerHTML = `
      <div class="resultados">
        <h2>Resultados</h2>
        <div class="resultados__nota"><span class="cnt-aciertos">${feedbackAnimActivo() ? 0 : aciertos}</span><span style="font-size:1.6rem;color:var(--color-texto-suave)">/${total}</span></div>
        <p class="resultados__detalle">Has acertado el <strong>${porcentaje}%</strong> de las preguntas · Tiempo total: <strong>${tiempoLegible}</strong></p>

        <div class="resultados__grafico">
          <canvas class="grafico-resultados" width="360" height="360"></canvas>
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
          <div class="mini-stat">
            <div class="mini-stat__valor" style="color:var(--color-primario);font-variant-numeric:tabular-nums">${tiempoLegible}</div>
            <div class="mini-stat__etiqueta">Tiempo</div>
          </div>
        </div>

        <div class="resultados__acciones">
          ${hayFalladas
            ? `<button type="button" class="btn" data-accion="repetir-falladas">Repetir sólo falladas (${estado.falladasIds.length})</button>`
            : ''}
          <button type="button" class="btn ${hayFalladas ? 'btn--secundario' : ''}" data-accion="repetir-todas">Repetir todas</button>
          <button type="button" class="btn btn--secundario" data-accion="volver">Volver a los temas</button>
        </div>
      </div>`;

    // Handlers (los botones dependen de si estamos en tab o en quiz.html)
    const b1 = cfg.cont.querySelector('[data-accion="repetir-falladas"]');
    if (b1) b1.addEventListener('click', () => iniciar({ ...cfg, modo: 'falladas' }));
    cfg.cont.querySelector('[data-accion="repetir-todas"]').addEventListener('click', () => iniciar({ ...cfg, modo: 'todas' }));
    cfg.cont.querySelector('[data-accion="volver"]').addEventListener('click', () => {
      if (cfg.alVolver) cfg.alVolver();
      else location.href = `ope.html?ope=${encodeURIComponent(cfg.ope)}`;
    });

    const ctx = cfg.cont.querySelector('.grafico-resultados');
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
        plugins: { legend: { position: 'bottom', labels: { font: { family: 'Barlow, Arial' } } } },
      },
    });

    cfg.cont.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const cntNodo = cfg.cont.querySelector('.cnt-aciertos');
    if (cntNodo) animarContador(cntNodo, aciertos, 900);
    if (porcentaje >= 80) lanzarConfetti();

    if (cfg.alTerminar) cfg.alTerminar();
  }

  function destruir() {
    if (crono.interval) clearInterval(crono.interval);
    crono = { inicio: null, acumulado: 0, interval: null, pausado: true, display: null, detenido: false };
    estado = null;
  }

  window.QuizEngine = {
    iniciar,
    pausarCronometro,
    reanudarCronometro,
    destruir,
    estaActivo: () => estado !== null,
  };
})();
