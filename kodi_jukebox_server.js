const express = require("express");
const cors = require("cors");
const fs = require("fs");
const WebSocket = require("ws"); // Necesitamos WebSocket y WebSocketServer
const http = require('http'); // Necesitamos el módulo http para crear el servidor base

const app = express();
const PORT = 3000;
// Asegúrate de tener node-fetch instalado (npm install node-fetch) si usas import()
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// --- Configuración ---
const KODI_USER = "kodi"; // Cambia si es necesario
const KODI_PASS = "kodi"; // Cambia si es necesario
const KODI_IP = "192.168.1.133"; // Confirma que esta es la IP correcta de tu Kodi
const KODI_PORT = "8080"; // Puerto HTTP JSON-RPC de Kodi
const KODI_WS_PORT = "9090"; // Puerto WebSocket de Kodi
const KODI_DIRECTORY = "C:\\Users\\Pablo\\Downloads\\Kodi"; // Directorio de música/video en el servidor
const DATA_FILE = "jukebox.json"; // Archivo de estado

app.use(cors());
app.use(express.json()); // Para parsear bodies JSON en las peticiones POST

// --- Estado Global del Servidor ---
let jukebox = {
  playlist: [],
  votantes: {},
  actualSonando: null // Guardará el OBJETO { label, file } de la canción sonando
};
let cancionesDisponiblesServidor = []; // Lista de canciones de la biblioteca { label, file }
let ultimoArchivoReproducido = null; // Para evitar repetición inmediata en aleatorio

// --- Servidor HTTP y WebSocket ---
// Crear servidor HTTP explícitamente para poder adjuntar el WebSocket Server
const server = http.createServer(app);
// Crear el Servidor WebSocket adjunto al servidor HTTP
const wss = new WebSocket.Server({ server });
// Set para almacenar todos los clientes WebSocket conectados
const clients = new Set();

console.log(`🔌 Servidor WebSocket listo para escuchar en el puerto ${PORT}`);

/**
 * Envía el estado actual de la jukebox a todos los clientes WebSocket conectados.
 */
function broadcastEstado() {
  const estadoActual = JSON.stringify({ type: 'actualizacion_estado', payload: jukebox });
  // console.log(`Broadcasting estado a ${clients.size} clientes.`); // Log opcional para debug
  clients.forEach((client) => {
    // Enviar solo si la conexión está abierta
    if (client.readyState === WebSocket.OPEN) {
      client.send(estadoActual, (err) => {
         if (err) {
            console.error("Error al enviar broadcast WS:", err);
         }
      });
    }
  });
}

// --- Manejo de Conexiones WebSocket (Clientes Navegador) ---
wss.on('connection', (ws) => {
  console.log('✅ Cliente WebSocket conectado');
  clients.add(ws); // Añadir nuevo cliente al Set

  // Enviar el estado completo actual solo a este nuevo cliente
  console.log('DEBUG: Intentando enviar estado inicial al nuevo cliente...');
  try {
      const estadoInicialMsg = JSON.stringify({ type: 'estado_inicial', payload: jukebox });
      ws.send(estadoInicialMsg);
      console.log('DEBUG: Estado inicial enviado correctamente.');
  } catch (err) {
      console.error("DEBUG: ERROR enviando estado inicial vía WS:", err);
  }

  // Listener para cuando un cliente se desconecta
  ws.on('close', () => {
    console.log('🔌 Cliente WebSocket desconectado');
    clients.delete(ws); // Eliminar cliente del Set
  });

  // Listener para errores en la conexión de un cliente
  ws.on('error', (error) => {
    console.error('❌ Error en WS cliente:', error);
    clients.delete(ws); // Eliminar cliente si hay error
  });

  // Listener para mensajes recibidos del cliente (opcional por ahora)
  ws.on('message', (message) => {
     try {
         const parsedMessage = JSON.parse(message);
         console.log('Mensaje recibido del cliente:', parsedMessage);
         // Aquí podrías manejar pings u otras interacciones si las implementas
     } catch (e) {
         console.warn("Mensaje WS inválido:", message);
     }
  });
});


// --- Carga Inicial de Estado y Biblioteca ---

/**
 * Carga la lista de canciones desde Kodi al iniciar el servidor.
 */
async function cargarBibliotecaKodi() {
  console.log("📚 Cargando biblioteca desde Kodi...");
  const body = {
    jsonrpc: "2.0",
    method: "Files.GetDirectory",
    params: {
        directory: KODI_DIRECTORY,
        media: "files" // O especificar 'music', 'video' si se prefiere
        // CORREGIDO: Eliminado el parámetro 'properties'
     },
    id: "GetDirectory_InitialLoad"
  };

  try {
    const response = await fetch(`http://${KODI_IP}:${KODI_PORT}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${KODI_USER}:${KODI_PASS}`).toString("base64") },
      body: JSON.stringify(body),
      timeout: 10000
    });

     if (!response.ok) { throw new Error(`Error HTTP ${response.status}`); }
     const data = await response.json();
     if (data.error || !data.result || !Array.isArray(data.result.files)) { throw new Error("Respuesta inválida de Kodi"); }

    // Procesar y guardar la biblioteca válida
    cancionesDisponiblesServidor = data.result.files
      .filter(f => f && f.file && /\.(mp4|mp3|flac|ogg|m4a|wav)$/i.test(f.file))
      .map(f => {
          const nombreLimpio = f.label?.replace(/\.[^/.]+$/, "") || f.file.split(/[\\/]/).pop().replace(/\.[^/.]+$/, "");
          return { label: nombreLimpio, file: f.file };
      });
    console.log(`✅ Biblioteca cargada con ${cancionesDisponiblesServidor.length} canciones válidas.`);

  } catch (error) {
    console.error("❌ ERROR FATAL al cargar la biblioteca desde Kodi:", error.message);
    cancionesDisponiblesServidor = [];
  }
}

/**
 * Carga el estado guardado de la Jukebox desde jukebox.json.
 */
function cargarEstadoGuardado() {
    if (fs.existsSync(DATA_FILE)) {
      try {
        const data = fs.readFileSync(DATA_FILE, "utf-8");
        const estadoGuardado = JSON.parse(data);
        jukebox.playlist = Array.isArray(estadoGuardado.playlist) ? estadoGuardado.playlist : [];
        jukebox.votantes = (typeof estadoGuardado.votantes === 'object' && estadoGuardado.votantes !== null) ? estadoGuardado.votantes : {};
        jukebox.actualSonando = (typeof estadoGuardado.actualSonando === 'object' && estadoGuardado.actualSonando?.file) ? estadoGuardado.actualSonando : null;
        console.log("📂 Estado cargado desde jukebox.json");
      } catch (err) {
        console.warn(`⚠️ Error al leer/parsear ${DATA_FILE}. Se iniciará desde cero. Error: ${err.message}`);
        jukebox = { playlist: [], votantes: {}, actualSonando: null };
        guardarEstado();
      }
    } else {
      jukebox = { playlist: [], votantes: {}, actualSonando: null };
      guardarEstado();
      console.log(`📄 Archivo ${DATA_FILE} no encontrado. Creado desde cero.`);
    }
     ultimoArchivoReproducido = jukebox.actualSonando?.file || null;
}

/**
 * Guarda el estado actual de la Jukebox en jukebox.json.
 */
function guardarEstado() {
  try {
    jukebox.playlist.sort((a, b) => b.votos - a.votos); // Ordenar antes de guardar
    fs.writeFileSync(DATA_FILE, JSON.stringify(jukebox, null, 2));
    // console.log("💾 Estado guardado."); // Opcional
  } catch (err) { console.error("❌ Error al guardar el estado:", err.message); }
}

// --- Endpoints HTTP API ---

// Endpoint para obtener la biblioteca de canciones
app.get("/canciones", (req, res) => { res.json({ files: [...cancionesDisponiblesServidor] }); });

// Endpoint antiguo (mantener temporalmente por compatibilidad con script.js actual)
app.post("/kodi", async (req, res) => {
    if (cancionesDisponiblesServidor.length > 0) { res.json({ files: [...cancionesDisponiblesServidor] }); }
    else { console.warn("WARN: /kodi llamado pero biblioteca no cargada."); res.status(503).json({ error: "Biblioteca no disponible." }); }
});

app.post("/proponer", (req, res) => {
  const { label, file, userId } = req.body;
  if (!label || !file || !userId) return res.status(400).json({ error: "Faltan datos" });
  if (jukebox.votantes[userId]) return res.status(400).json({ error: "Ya has votado/propuesto" });
  if (jukebox.playlist.some(c => c.file === file)) return res.status(400).json({ error: "Ya está en cola" });
  if (!cancionesDisponiblesServidor.some(c => c.file === file)) { return res.status(400).json({ error: "Canción no encontrada." }); }
  jukebox.playlist.push({ label, file, votos: 1, propuestoPor: userId });
  jukebox.votantes[userId] = file;
  guardarEstado();
  broadcastEstado(); // Notificar a todos
  res.status(200).json({ success: true }); // Responder solo éxito
});

app.post("/votar", (req, res) => {
  const { file, userId } = req.body;
  if (!file || !userId) return res.status(400).json({ error: "Faltan datos" });
  if (jukebox.votantes[userId]) return res.status(400).json({ error: "Ya has votado/propuesto" });
  const cancionIndex = jukebox.playlist.findIndex(c => c.file === file);
  if (cancionIndex === -1) return res.status(404).json({ error: "Canción no encontrada" });
  jukebox.playlist[cancionIndex].votos++;
  jukebox.votantes[userId] = file;
  guardarEstado();
  broadcastEstado(); // Notificar a todos
  res.status(200).json({ success: true }); // Responder solo éxito
});

app.get("/estado", (req, res) => {
  jukebox.playlist.sort((a, b) => b.votos - a.votos);
  res.json(jukebox);
});

// --- Lógica de Reproducción y WebSocket con Kodi ---

/**
 * Envía comando Player.Open a Kodi para reproducir un archivo.
 */
async function enviarComandoPlayKodi(file, label) {
    console.log(`▶️ Intentando reproducir vía Kodi: ${label} (${file})`);
    const body = { jsonrpc: "2.0", method: "Player.Open", params: { item: { file: file } }, id: "PlayerOpen_Jukebox_" + Date.now() };
    try {
      const res = await fetch(`http://${KODI_IP}:${KODI_PORT}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${KODI_USER}:${KODI_PASS}`).toString("base64") }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`Error HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(`Error Kodi: ${JSON.stringify(data.error)}`);
      console.log(`✅ Comando Player.Open enviado para: ${label}`);
      jukebox.actualSonando = { label: label, file: file };
      ultimoArchivoReproducido = file;
      guardarEstado();
      broadcastEstado(); // Notificar cambio
      return true;
    } catch (err) {
      console.error(`❌ Error en fetch Player.Open (${label}): ${err.message}`);
      if (jukebox.actualSonando?.file === file) jukebox.actualSonando = null; // Limpiar si falló el play de este archivo
      guardarEstado();
      broadcastEstado(); // Notificar fallo
      return false;
    }
}

/**
 * Decide qué reproducir después de que una canción termina (Player.OnStop).
 */
async function reproducirSiguienteCancion() {
  console.log("🎵 Evaluando qué reproducir a continuación...");
  const archivoRecienTerminado = ultimoArchivoReproducido;
  if (jukebox.actualSonando !== null) { // Limpiar estado sonando (la canción ya paró según OnStop)
       jukebox.actualSonando = null;
       // No guardar aquí, se guarda después de decidir qué poner o si no hay nada
  }

  if (jukebox.playlist.length > 0) { // Hay cola
    jukebox.playlist.sort((a, b) => b.votos - a.votos);
    const siguiente = jukebox.playlist[0];
    if (!siguiente?.file) { /* ... (manejo error canción inválida) ... */ console.error("Inválido en cola"); jukebox.playlist.shift(); guardarEstado(); broadcastEstado(); setTimeout(reproducirSiguienteCancion, 100); return; }
    const exito = await enviarComandoPlayKodi(siguiente.file, siguiente.label);
    if (exito) {
      const votantesAEliminar = [];
      for (const [uid, fileVotado] of Object.entries(jukebox.votantes)) { if (fileVotado === siguiente.file) votantesAEliminar.push(uid); }
      votantesAEliminar.forEach(uid => delete jukebox.votantes[uid]);
      console.log(`🧹 Votos reiniciados para ${votantesAEliminar.length} usuarios.`);
      jukebox.playlist = jukebox.playlist.filter(c => c.file !== siguiente.file);
      guardarEstado();
      broadcastEstado(); // Notificar cambios en lista y votos
    } else { /* ... (manejo error play, quitar canción?) ... */ console.warn(`Fallo play ${siguiente.label}`); jukebox.playlist.shift(); guardarEstado(); broadcastEstado(); setTimeout(reproducirSiguienteCancion, 1000); }
  } else { // Cola vacía -> Aleatorio
    console.log("ℹ️ Playlist vacía. Seleccionando aleatoria...");
    if (cancionesDisponiblesServidor.length === 0) { console.warn("⚠️ Biblioteca vacía."); guardarEstado(); broadcastEstado(); return; }
    let posiblesCanciones = cancionesDisponiblesServidor;
    if (archivoRecienTerminado && posiblesCanciones.length > 1) { posiblesCanciones = posiblesCanciones.filter(c => c.file !== archivoRecienTerminado); if (posiblesCanciones.length === 0) posiblesCanciones = cancionesDisponiblesServidor; }
    const randomIndex = Math.floor(Math.random() * posiblesCanciones.length);
    const cancionAleatoria = posiblesCanciones[randomIndex];
    if (!cancionAleatoria?.file) { console.error("❌ Error seleccionando aleatoria."); guardarEstado(); broadcastEstado(); return; }
    await enviarComandoPlayKodi(cancionAleatoria.file, cancionAleatoria.label); // Esto ya guarda estado y notifica
  }
}

/**
 * Detecta la canción actual según Kodi y actualiza el estado.
 */
async function detectarCancionActual() {
  console.log("🔎 Intentando detectar canción actual vía HTTP JSON-RPC...");
  const body = { jsonrpc: "2.0", method: "Player.GetItem", params: { playerid: 1, properties: ["title", "file", "artist", "album"] }, id: "GetItem_Jukebox" };
  try {
    const res = await fetch(`http://${KODI_IP}:${KODI_PORT}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${KODI_USER}:${KODI_PASS}`).toString("base64") }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Error HTTP ${res.status}`);
    const data = await res.json();
    // console.log('Respuesta Kodi Player.GetItem:', JSON.stringify(data, null, 2)); // Opcional
    if (data.error) { console.warn(`⚠️ Error en respuesta Player.GetItem: ${JSON.stringify(data.error)}`); return; }
    const item = data.result?.item;
    const nuevoSonando = (item?.file && item.file !== "") ? { label: item.title || item.file.split(/[\\/]/).pop().replace(/\.[^/.]+$/, ""), file: item.file } : null; // Comprobar que file no sea ""
    if (JSON.stringify(jukebox.actualSonando) !== JSON.stringify(nuevoSonando)) {
        jukebox.actualSonando = nuevoSonando;
        ultimoArchivoReproducido = nuevoSonando?.file || null;
        guardarEstado();
        if (nuevoSonando) console.log("🎶 Reproduciendo ahora (detectado):", nuevoSonando.label); else console.log("ℹ️ Nada sonando ahora (detectado).");
        broadcastEstado(); // Notificar cambio
    }
  } catch (err) { console.warn(`⚠️ Error en fetch Player.GetItem: ${err.message}`); }
}

/**
 * Conecta y maneja el WebSocket con Kodi para recibir eventos.
 */
function conectarWebSocket() {
  const wsUrl = `ws://${KODI_IP}:${KODI_WS_PORT}/jsonrpc`;
  console.log(`🔌 Intentando conectar WebSocket a Kodi en ${wsUrl}...`);
  const ws = new WebSocket(wsUrl, {});
  ws.on("open", () => { console.log("✅ WebSocket conectado con Kodi"); });
  ws.on("message", async (data) => {
    try {
      const mensaje = JSON.parse(data.toString());
      if (mensaje.id) return; // Ignorar respuestas
      if (mensaje.method === "Player.OnStop") {
        console.log("⏹️ Player.OnStop recibido.");
        setTimeout(() => reproducirSiguienteCancion(), 500); // Llamar a lógica de reproducción
      } else if (mensaje.method === "Player.OnPlay") {
        console.log("▶️ Player.OnPlay recibido.");
        setTimeout(() => detectarCancionActual(), 500); // Detectar qué empezó a sonar
      }
    } catch (err) { console.error("⚠️ Error procesando mensaje WS Kodi:", err); console.error("Mensaje:", data.toString()); }
  });
  ws.on("close", (code, reason) => { console.log(`🔌 WS cerrado. ${code}/${reason}. Reintentando en 5s...`); setTimeout(conectarWebSocket, 5000); });
  ws.on("error", (err) => { console.error(`❌ Error WS Kodi: ${err.message}.`); });
}

// --- Inicialización del Servidor ---
async function iniciarServidor() {
    cargarEstadoGuardado();
    await cargarBibliotecaKodi();
    // Usar 'server.listen' del objeto http creado al principio
    server.listen(PORT, () => {
      console.log(`✅ Servidor HTTP y WS corriendo en http://localhost:${PORT}`);
      conectarWebSocket();
       setTimeout(detectarCancionActual, 2000); // Chequeo inicial
    });
}
iniciarServidor().catch(err => { console.error("💥 Error fatal:", err); process.exit(1); });

// --- Cierre Graceful ---
process.on('SIGINT', () => {
  console.log("\n🔌 SIGINT. Guardando estado...");
  guardarEstado();
  console.log("✅ Estado guardado. Adiós.");
  process.exit(0);
});