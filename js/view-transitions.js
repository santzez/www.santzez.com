/* =============================================================
   view-transitions.js — Categoría D
   -------------------------------------------------------------
   Las View Transitions cross-document se activan mediante la
   meta tag <meta name="view-transition" content="same-origin">.
   Este script la añade/quita dinámicamente según la preferencia
   del usuario. Los estilos ::view-transition-* viven en CSS,
   condicionados a html.anim-view-transitions.

   Soporte: Chrome 126+, Edge 126+, Safari 18+, Firefox aún no.
   Si el navegador no soporta la API, la meta tag se ignora
   silenciosamente y la navegación sigue funcionando como antes.
   ============================================================= */

(function () {
  const META_ID = 'meta-view-transition';

  function sincronizarMeta() {
    const activo = document.documentElement.classList.contains('anim-view-transitions');
    let meta = document.getElementById(META_ID);
    if (activo) {
      if (!meta) {
        meta = document.createElement('meta');
        meta.id = META_ID;
        meta.name = 'view-transition';
        meta.content = 'same-origin';
        document.head.appendChild(meta);
      }
    } else if (meta) {
      meta.remove();
    }
  }

  // Al cargar la página (después de que preferencias.js aplique la clase)
  sincronizarMeta();

  // Observa cambios en las clases de <html> para reaccionar cuando el usuario
  // activa/desactiva el toggle sin recargar.
  new MutationObserver(sincronizarMeta).observe(document.documentElement, {
    attributes: true, attributeFilter: ['class']
  });
})();
