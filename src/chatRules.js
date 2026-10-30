// Reutilizado de azafe/ONG, apps/backend/src/chat.js (main, 2026-10-30).
// Las consultas, identidad y transporte se adaptan en chat.js para Bandidos.
export const MAX_TEXTO = 4000;
export const MAX_NOMBRE_GRUPO = 60;
export const HORAS_PARA_BORRAR = 24;
export const MINUTOS_PARA_EDITAR = 15;
export const EMOJIS_REACCION = ['👍','❤️','😂','😮','😢','✅'];
export class ChatInvalidoError extends Error { status = 400; }

export function textoDeMensaje(valor) {
  if (valor == null) return null;
  if (typeof valor !== "string") throw new ChatInvalidoError("El mensaje tiene que ser texto");
  const limpio = valor.replace(/\r\n/g, "\n").trim();
  if (!limpio) return null;
  if (limpio.length > MAX_TEXTO) throw new ChatInvalidoError(`El mensaje no puede pasar de ${MAX_TEXTO} caracteres`);
  return limpio;
}

export function nombreDeGrupo(valor) {
  const limpio = typeof valor === "string" ? valor.trim() : "";
  if (!limpio) throw new ChatInvalidoError("Falta el nombre del grupo");
  if (limpio.length > MAX_NOMBRE_GRUPO) throw new ChatInvalidoError("El nombre del grupo es demasiado largo");
  return limpio;
}

/* Lo que dice el push: "Ana" o "Ana · Choferes"; el texto, o "📷 Foto". Con
   ocultarTexto, solo "Nuevo mensaje": es lo que se ve con el celular
   bloqueado. A quien mencionan, "Ana te mencionó". */
export function textoDelPush({ autor, grupo, texto, conFoto, ocultarTexto = false, mencion = false }) {
  const quien = mencion ? `${autor} te mencionó` : autor;
  const title = grupo ? `${quien} · ${grupo}` : quien;
  if (ocultarTexto) return { title, body: mencion ? "Te mencionaron en un mensaje" : "Nuevo mensaje" };
  const cuerpo = texto ? texto.slice(0, 140) : "";
  const body = conFoto ? (cuerpo ? `📷 ${cuerpo}` : "📷 Foto") : cuerpo;
  return { title, body };
}

/* Si quien pide puede borrar ese mensaje: el autor durante HORAS_PARA_BORRAR;
   la dirección, cualquiera y cuando sea. Nunca uno ya borrado. */
export function puedeBorrarMensaje(mensaje, userId, { esDireccion = false, ahora = Date.now() } = {}) {
  if (!mensaje || mensaje.eliminado_at) return false;
  if (esDireccion) return true;
  if (mensaje.autor_id !== userId) return false;
  return ahora - Date.parse(mensaje.created_at) <= HORAS_PARA_BORRAR * 3600_000;
}

/* Corregir un mensaje: solo el autor, durante MINUTOS_PARA_EDITAR. */
export function puedeEditarMensaje(mensaje, userId, ahora = Date.now()) {
  if (!mensaje || mensaje.eliminado_at || mensaje.autor_id !== userId) return false;
  return ahora - Date.parse(mensaje.created_at) <= MINUTOS_PARA_EDITAR * 60_000;
}

