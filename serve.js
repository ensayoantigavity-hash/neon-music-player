const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const app = express();

// Configurar puerto dinámico para Render o local (puerto 3000)
const PORT = process.env.PORT || 3000;

// Habilitar JSON y servir archivos visuales del frontend (HTML, CSS, JS)
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * RUTA PRINCIPAL DE BÚSQUEDA Y AUTO DJ INFINITO
 * Recibe un término como "clasicos de los 80" y devuelve un listado de canciones blindado contra bloqueos.
 */
app.get('/api/search', (req, res) => {
    const queryUsuario = req.query.q;

    if (!queryUsuario) {
        return res.status(400).json({ error: "Falta el parámetro de búsqueda 'q'" });
    }

    // Estrategia: Forzamos la búsqueda hacia listas de reproducción (mixes) para alimentar el Auto DJ
    const queryOptimizado = `${queryUsuario} mix playlist`;

    /**
     * CONFIGURACIÓN DE PARÁMETROS ANTIBLOQUEO:
     * - ytsearch15: Trae hasta 15 canciones del mismo estilo de golpe.
     * - --flat-playlist: Extrae metadatos en milisegundos sin consumir CPU ni descargar archivos en Render.
     * - --extractor-args: Fuerza el cliente web móvil ("mweb"), el cual no exige obligatoriamente firmas PO Token estrictas.
     * - --no-cache-dir: Evita almacenar cookies o sesiones corruptas que gatillen el captcha de robots de YouTube.
     */
    const comandoYtdlp = `yt-dlp "ytsearch15:${queryOptimizado}" --flat-playlist --extractor-args "youtube:player-client=mweb" --no-cache-dir --dump-json --ignore-errors`;

    exec(comandoYtdlp, (error, stdout, stderr) => {
        if (error) {
            console.error("Error al ejecutar yt-dlp:", error);
            return res.status(500).json({ error: "Error interno procesando la música." });
        }

        // Procesar las respuestas en formato JSON plano devueltas por la terminal
        const lineas = stdout.trim().split('\n');
        let listaCanciones = [];

        lineas.forEach(linea => {
            try {
                if (!linea) return;
                const item = JSON.parse(linea);

                // Si yt-dlp extrajo una lista/mix completa de YouTube, guardamos sus canciones internas
                if (item._type === 'playlist' && item.entries) {
                    item.entries.forEach(track => {
                        if (track.title && track.id) {
                            listaCanciones.push({
                                title: track.title,
                                id: track.id,
                                url: `https://youtube.com{track.id}`,
                                duration: track.duration || 0
                            });
                        }
                    });
                } else if (item.title && item.id) {
                    // Si devolvió un video musical individual directo del mix
                    listaCanciones.push({
                        title: item.title,
                        id: item.id,
                        url: item.webpage_url || `https://youtube.com{item.id}`,
                        duration: item.duration || 0
                    });
                }
            } catch (e) {
                // Saltar líneas vacías o errores parciales de lectura de JSON
            }
        });

        // Respuesta limpia en formato JSON para que el reproductor gráfico (Frontend) la lea sin problemas
        res.json({
            busquedaOriginal: queryUsuario,
            totalCanciones: listaCanciones.length,
            canciones: listaCanciones
        });
    });
});

/**
 * RUTA PARA OBTENER EL ENLACE DIRECTO DE AUDIO (STREAMING)
 * Cuando el reproductor le dé a "Play", consulta esta ruta para recibir el flujo de audio puro en alta fidelidad.
 */
app.get('/api/stream', (req, res) => {
    const videoId = req.query.id;
    if (!videoId) return res.status(400).json({ error: "Falta el ID del video" });

    const videoUrl = `https://youtube.com{videoId}`;
    
    // Extrae directamente la URL del flujo de transmisión de audio óptimo (M4A/AAC a 44.1kHz) evadiendo bloqueos
    const comandoStream = `yt-dlp "${videoUrl}" --extractor-args "youtube:player-client=mweb" --no-cache-dir -f "bestaudio" -g`;

    exec(comandoStream, (error, stdout, stderr) => {
        if (error) {
            console.error("Error al extraer streaming de audio:", error);
            return res.status(500).json({ error: "No se pudo obtener el audio de este tema." });
        }

        const streamUrl = stdout.trim();
        res.json({ audioUrl: streamUrl });
    });
});

// Iniciar el servidor de tu radio Neon Music
app.listen(PORT, () => {
    console.log(`Neon Music Server corriendo con éxito en el puerto ${PORT}`);
});

