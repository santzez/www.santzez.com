/* =============================================================
   chat-ia.js — Chat contextual con Claude Haiku (Edge Function)
   API:
     ChatIA.montar({ contenedor, cliente, idTema, contextoHtml })
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
    // Muy básico: **negrita**, *cursiva*, saltos de línea, viñetas
    let t = texto
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    // Líneas que empiezan por "- " o "* " → lista
    const lineas = t.split('\n');
    const out = [];
    let enLista = false;
    for (const l of lineas) {
      const m = l.match(/^\s*[-*]\s+(.*)$/);
      if (m) {
        if (!enLista) { out.push('<ul>'); enLista = true; }
        out.push('<li>' + m[1] + '</li>');
      } else {
        if (enLista) { out.push('</ul>'); enLista = false; }
        if (l.trim()) out.push('<p>' + l + '</p>');
      }
    }
    if (enLista) out.push('</ul>');
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
    montar({ contenedor, cliente, idTema, contextoHtml }) {
      const mensajes = contenedor.querySelector('#chat-mensajes');
      const form = contenedor.querySelector('#chat-form');
      const input = contenedor.querySelector('#chat-input');
      const btn = contenedor.querySelector('#chat-enviar');
      const cuotaNodo = contenedor.querySelector('#chat-cuota');
      const historial = [];

      const contextoTexto = extraerTextoDeHtml(contextoHtml).slice(0, 55000);
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
              idTema,
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
