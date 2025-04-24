document.addEventListener("DOMContentLoaded", () => {
  const listaBibliotecaUl = document.getElementById("lista");
  const playlistQueueUl = document.getElementById("playlist-queue");
  const estadoSpan = document.getElementById("estado");
  const inputBusqueda = document.getElementById("busqueda");

  let todasLasCanciones = [];
  let currentPlaylist = [];
  let currentVotantes = {};
  let currentUserId = localStorage.getItem("userId") || generarIdUsuario();
  let currentlyPlayingFile = null;
  let ws = null;
  let bibliotecaCargada = false;

  const BASE_URL = "https://e63f-2a0c-5a85-d105-8300-f9bb-a4e9-f169-60cf.ngrok-free.app";

  function generarIdUsuario() {
    const id = crypto.randomUUID ? crypto.randomUUID() : "user_" + Math.random().toString(36).substring(2, 15);
    localStorage.setItem("userId", id);
    return id;
  }

  function cargarCanciones() {
    fetch(`${BASE_URL}/kodi`, { method: "POST", headers: { "Content-Type": "application/json" } })
      .then(res => res.json())
      .then(data => {
        todasLasCanciones = data.files
          .map(f => {
            if (!f?.file) return null;
            let nombre = f.label?.replace(/\.(mp4|mp3|flac|ogg|m4a|wav)$/i, "");
            if (!nombre) nombre = f.file.split(/[\\/]/).pop().replace(/\.(mp4|mp3|flac|ogg|m4a|wav)$/i, "");
            return { label: nombre, file: f.file };
          })
          .filter(Boolean);
        bibliotecaCargada = true;
        actualizarBiblioteca();
      })
      .catch(err => {
        listaBibliotecaUl.innerHTML = `<li class="mensaje-lista">Error al cargar biblioteca: ${err.message}</li>`;
        bibliotecaCargada = false;
      });
  }

  function mostrarLista(cancionesAMostrar) {
    listaBibliotecaUl.innerHTML = "";
    if (cancionesAMostrar.length === 0) {
      listaBibliotecaUl.innerHTML = `<li class="mensaje-lista">Biblioteca vacía o todas las canciones están en cola/sonando.</li>`;
      return;
    }

    cancionesAMostrar.forEach(c => {
      const li = document.createElement("li");
      const textoSpan = document.createElement("span");
      textoSpan.textContent = c.label;
      li.appendChild(textoSpan);

      const controlesSpan = document.createElement("span");
      const btn = document.createElement("button");
      btn.textContent = "Proponer";

      if (!currentVotantes[currentUserId]) {
        btn.onclick = () => proponerCancion(c);
      } else {
        btn.disabled = true;
        btn.title = "Ya has propuesto o votado";
      }

      controlesSpan.appendChild(btn);
      li.appendChild(controlesSpan);
      listaBibliotecaUl.appendChild(li);
    });
  }

  function actualizarBiblioteca() {
    if (!bibliotecaCargada) {
      listaBibliotecaUl.innerHTML = `<li class="mensaje-lista">Cargando biblioteca...</li>`;
      return;
    }

    const textoBusqueda = inputBusqueda.value.toLowerCase().trim();
    const archivosEnPlaylist = new Set(currentPlaylist.map(song => song.file));

    const cancionesFiltradas = todasLasCanciones.filter(c =>
      !archivosEnPlaylist.has(c.file) &&
      (currentlyPlayingFile === null || c.file !== currentlyPlayingFile) &&
      (textoBusqueda === "" || c.label.toLowerCase().includes(textoBusqueda))
    );

    mostrarLista(cancionesFiltradas);
  }

  function proponerCancion(cancion) {
    if (currentVotantes[currentUserId]) {
      alert("Ya has propuesto o votado.");
      return;
    }

    fetch(`${BASE_URL}/proponer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...cancion, userId: currentUserId })
    })
      .then(res => res.json())
      .then(() => console.log("Propuesta enviada"))
      .catch(err => alert("Error al proponer: " + err.message));
  }

  function votarCancion(file) {
    if (currentVotantes[currentUserId]) {
      alert("Ya has votado o propuesto.");
      return;
    }

    fetch(`${BASE_URL}/votar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file, userId: currentUserId })
    })
      .then(res => res.json())
      .then(() => console.log("Voto enviado"))
      .catch(err => alert("Error al votar: " + err.message));
  }

  function renderizarPlaylist() {
    playlistQueueUl.innerHTML = "";

    if (currentPlaylist.length === 0) {
      playlistQueueUl.innerHTML = `<li class="mensaje-lista">La cola está vacía. ¡Propón una canción!</li>`;
      return;
    }

    currentPlaylist.forEach(c => {
      const li = document.createElement("li");
      const texto = document.createElement("span");
      texto.textContent = `${c.label} - Votos: ${c.votos || 1}`;
      li.appendChild(texto);

      const controlesSpan = document.createElement("span");
      const btn = document.createElement("button");
      btn.textContent = "Votar";

      const yaVotado = currentVotantes[currentUserId] === c.file;
      const esPropuestaMia = c.propuestoPor === currentUserId;

      if (yaVotado || esPropuestaMia) {
        btn.disabled = true;
        btn.title = yaVotado ? "Ya votaste esta canción" : "Tú la propusiste";
      } else {
        btn.onclick = () => votarCancion(c.file);
      }

      controlesSpan.appendChild(btn);
      li.appendChild(controlesSpan);
      playlistQueueUl.appendChild(li);
    });
  }

  function actualizarInterfazCompleta(sonandoObj) {
    if (sonandoObj) {
      const nombre = sonandoObj.label || sonandoObj.file?.split(/[\\/]/).pop().replace(/\.[^/.]+$/, "") || "Desconocido";
      estadoSpan.innerHTML = `🎶 <strong>Reproduciendo:</strong> ${nombre}`;
    } else {
      estadoSpan.innerHTML = `🎵 <em>Esperando canción...</em>`;
    }

    renderizarPlaylist();
    actualizarBiblioteca();
    localStorage.setItem("lastPlayingFile", currentlyPlayingFile);
  }

  function conectarWebSocketCliente() {
    const wsUrl = `wss://e63f-2a0c-5a85-d105-8300-f9bb-a4e9-f169-60cf.ngrok-free.app`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => estadoSpan.innerHTML = "Conectado.";
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg?.type === "estado_inicial" || msg?.type === "actualizacion_estado") {
          const state = msg.payload;
          currentPlaylist = state.playlist || [];
          currentVotantes = state.votantes || {};
          currentlyPlayingFile = state.actualSonando?.file || null;
          actualizarInterfazCompleta(state.actualSonando);
        }
      } catch (e) {
        console.error("Error procesando mensaje WS:", e);
      }
    };
    ws.onclose = () => setTimeout(conectarWebSocketCliente, 5000);
    ws.onerror = () => estadoSpan.innerHTML = "<span style='color:red;'>Error de conexión</span>";
  }

  inputBusqueda.addEventListener("input", actualizarBiblioteca);

  console.log("Inicializando Jukebox...");
  conectarWebSocketCliente();
  cargarCanciones();
});
