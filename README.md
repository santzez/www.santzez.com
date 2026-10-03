# www.santzez.com

Web personal privada (no indexada) de Lu. Su apartado principal es **Oposizioak**:
apuntes, Qwiz, informes de examen y simulacros para preparar oposiciones de DonostiaTIK.

- Web estática servida por GitHub Pages con dominio propio (`CNAME`).
- Usuarios, progreso y contenido privado en Supabase (`js/supabase-config.js`).
- Estructura de cada oposición en `oposizioak/data/<OPE>/info.json` (jerarquía de secciones).
- El contenido privado (informes y simulacros) **no** está en este repositorio, que es público:
  vive en el bucket `privado` de Supabase y solo lo puede leer el admin.
