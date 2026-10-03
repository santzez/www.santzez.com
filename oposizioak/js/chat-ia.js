/* =============================================================
   chat-ia.js — Chat contextual con Claude Haiku (Edge Function)
   API:
     ChatIA.montar({ contenedor, cliente, idTema, contextoHtml })
     (idTema y contextoHtml pueden ser funciones: se leen en cada pregunta)
   ============================================================= */

(function () {
  const FN_URL_PATH = '/functions/v1/preguntar-tema';
  const MAX_HISTORIAL = 4;   // últimos turnos a enviar

  function extraerTextoDeHtml(html) {
    // Elimina scripts/styles y extrae texto legible
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, nav').forEach(el => el.remove());
    // preservamos saltos entre párrafos
    doc.querySelectorAll('p, li, h2, h3, h4, h5, tr').forEach(el => {
      el.insertAdjacentText('afterend', '\n');
    });
    return doc.body.textContent.replace(/\n{3,}/g, '\n\n').trim();
  }

  function crearBurbuja(rol, texto = '') {
    const div = document.createElement('div');
    div.className = 'chat-burbuja chat-burbuja--' + rol;
    div.textContent = texto;
    return div;
  }

  function renderMarkdownLigero(texto) {
    // Básico: **negrita**, *cursiva*, `código`, encabezados, viñetas,
    // listas numeradas y tablas con barras verticales.
    let t = texto
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    const lineas = t.split('\n');
    const out = [];
    let lista = null;   // 'ul' | 'ol' | null
    let tabla = null;   // filas acumuladas
    const cerrarLista = () => { if (lista) { out.push(`</${lista}>`); lista = null; } };
    const celdas = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    const cerrarTabla = () => {
      if (!tabla) return;
      const [cab, ...resto] = tabla.filter(f => !/^\|?\s*:?-{2,}/.test(f.trim()));
      out.push('<div class="chat-tabla"><table><thead><tr>' +
        celdas(cab).map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' +
        resto.map(f => '<tr>' + celdas(f).map(c => `<td>${c}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>');
      tabla = null;
    };
    for (const l of lineas) {
      if (/^\s*\|.*\|\s*$/.test(l)) { cerrarLista(); (tabla ||= []).push(l); continue; }
      cerrarTabla();
      const h = l.match(/^\s*(#{1,4})\s+(.*)$/);
      const ul = l.match(/^\s*[-*]\s+(.*)$/);
      const ol = l.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        const tipo = ul ? 'ul' : 'ol';
        if (lista !== tipo) { cerrarLista(); out.push(`<${tipo}>`); lista = tipo; }
        out.push('<li>' + (ul || ol)[1] + '</li>');
        continue;
      }
      cerrarLista();
      if (h) out.push(`<p class="chat-titulo">${h[2]}</p>`);
      else if (l.trim()) out.push('<p>' + l + '</p>');
    }
    cerrarLista(); cerrarTabla();
    return out.join('');
  }

  async function actualizarCuota(cliente, nodoCuota) {
    try {
      const { data, error } = await cliente.rpc('chat_cuota_restante');
      if (error || !data) { nodoCuota.textContent = ''; return; }
      if (data.es_admin) {
        nodoCuota.innerHTML = '<span class="chat-cuota__badge">admin · sin límite</span>';
      } else {
        const r = data.restantes ?? 0;
        nodoCuota.innerHTML =
          `<span class="chat-cuota__badge${r === 0 ? ' agotada' : ''}">` +
          `${r} / ${data.maximo ?? 20} restantes hoy</span>`;
      }
    } catch { nodoCuota.textContent = ''; }
  }

  window.ChatIA = {
    markdown: renderMarkdownLigero,

    /**
     * Consulta suelta (sin UI de chat), p. ej. para corregir el simulacro de
     * examen. Devuelve el texto completo; onTexto recibe el acumulado al vuelo.
     * modo 'corregir' usa en la función el modelo corrector (solo admin).
     */
    async consultar({ cliente, pregunta, contexto, idTema, onTexto, modo }) {
      const supabaseUrl = (cliente.rest && cliente.rest.url)
        ? cliente.rest.url.replace(/\/rest\/v1\/?$/, '')
        : (typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : '');
      const { data: { session } } = await cliente.auth.getSession();
      if (!session) throw new Error('No hay sesión');
      const resp = await fetch(supabaseUrl + FN_URL_PATH, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + session.access_token,
          'Content-Type': 'application/json',
          'apikey': (typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : ''),
        },
        body: JSON.stringify({ pregunta, contextoTema: contexto.slice(0, 55000), historial: [], idTema, modo }),
      });
      if (!resp.ok) {
        let msg = 'Error ' + resp.status;
        try { msg = (await resp.json()).error || msg; } catch {}
        throw new Error(msg);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let acumulado = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acumulado += decoder.decode(value, { stream: true });
        if (onTexto) onTexto(acumulado);
      }
      return acumulado;
    },

    montar({ contenedor, cliente, idTema, contextoHtml }) {
      const mensajes = contenedor.querySelector('#chat-mensajes');
      const form = contenedor.querySelector('#chat-form');
      const input = contenedor.querySelector('#chat-input');
      const btn = contenedor.querySelector('#chat-enviar');
      const cuotaNodo = contenedor.querySelector('#chat-cuota');
      const historial = [];

      // El contexto puede cambiar (p. ej. Informe del examen: "Exámenes y guía"
      // o "Mi informe"); si cambia, el historial deja de valer.
      const leer = (v) => (typeof v === 'function' ? v() : v);
      let htmlAnterior = null;
      let contextoTexto = '';
      actualizarCuota(cliente, cuotaNodo);

      // Endpoint completo de la Edge Function
      const supabaseUrl = (cliente.rest && cliente.rest.url)
        ? cliente.rest.url.replace(/\/rest\/v1\/?$/, '')
        : (typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : '');
      const endpoint = supabaseUrl + FN_URL_PATH;

      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const pregunta = input.value.trim();
        if (pregunta.length < 3) return;
        const htmlActual = leer(contextoHtml) || '';
        if (htmlActual !== htmlAnterior) {
          if (htmlAnterior !== null) historial.length = 0;
          htmlAnterior = htmlActual;
          contextoTexto = extraerTextoDeHtml(htmlActual).slice(0, 55000);
        }

        // Limpiar mensaje "vacío" si existe
        mensajes.querySelector('.chat-ia__vacio')?.remove();

        // Añadir burbuja usuario
        const burbujaUser = crearBurbuja('user', pregunta);
        mensajes.appendChild(burbujaUser);

        // Preparar burbuja assistant (vacía, se llenará con streaming)
        const burbujaAI = crearBurbuja('assistant', '');
        burbujaAI.innerHTML = '<span class="chat-burbuja__spinner"></span>';
        mensajes.appendChild(burbujaAI);
        mensajes.scrollTop = mensajes.scrollHeight;

        input.value = '';
        input.disabled = true;
        btn.disabled = true;

        try {
          const { data: { session } } = await cliente.auth.getSession();
          if (!session) throw new Error('No hay sesión');

          const resp = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + session.access_token,
              'Content-Type': 'application/json',
              'apikey': (typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : ''),
            },
            body: JSON.stringify({
              pregunta,
              contextoTema: contextoTexto,
              historial: historial.slice(-MAX_HISTORIAL * 2),
              idTema: leer(idTema),
            }),
          });

          if (!resp.ok) {
            let msg = 'Error ' + resp.status;
            try {
              const j = await resp.json();
              msg = j.error || msg;
            } catch {}
            burbujaAI.innerHTML = '<em class="chat-burbuja__error">⚠ ' + msg + '</em>';
            return;
          }

          // Streaming: leer el body como texto por chunks
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let acumulado = '';
          burbujaAI.innerHTML = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            acumulado += decoder.decode(value, { stream: true });
            burbujaAI.innerHTML = renderMarkdownLigero(acumulado);
            mensajes.scrollTop = mensajes.scrollHeight;
          }
          // Guardar en historial local
          historial.push({ rol: 'user', texto: pregunta });
          historial.push({ rol: 'assistant', texto: acumulado });
          // Refrescar cuota
          actualizarCuota(cliente, cuotaNodo);
        } catch (e) {
          burbujaAI.innerHTML = '<em class="chat-burbuja__error">⚠ ' + e.message + '</em>';
        } finally {
          input.disabled = false;
          btn.disabled = false;
          input.focus();
        }
      });

      // Enter para enviar (Shift+Enter para nueva línea)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          form.requestSubmit();
        }
      });
    },
  };
})();
