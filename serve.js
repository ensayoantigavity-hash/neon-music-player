import express from 'express';
import { exec } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración necesaria en módulos modernos para manejar rutas de carpetas
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * RUTA PRINCIPAL DE BÚSQUEDA Y AUTO DJ INFINITO
 */
app.get('/api/search', (req, res) => {
    const queryUsuario = req.query.q;

    if (!queryUsuario) {
        return res.status(400).json({ error: "Falta el parámetro de búsqueda 'q'" });
    }

    const queryOptimizado = `${queryUsuario} mix playlist`;

    // Parámetros antibloqueo optimizados
    const comandoYtdlp = `yt-dlp "ytsearch15:${queryOptimizado}" --flat-playlist --extractor-args "youtube:player-client=mweb" --no-cache-dir --dump-json --ignore-errors`;

    exec(comandoYtdlp, (error, stdout, stderr) => {
        if (error) {
            console.error("Error al ejecutar yt-dlp:", error);
            return res.status(500).json({ error: "Error interno procesando la música." });
        }

        const lineas = stdout.trim().split('\n');
        let listaCanciones = [];

        lineas.forEach(linea => {
            try {
                if (!linea) return;
                const item = JSON.parse(linea);

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
                    listaCanciones.push({
                        title: item.title,
                        id: item.id,
                        url: item.webpage_url || `https://youtube.com{item.id}`,
                        duration: item.duration || 0
                    });
                }
            } catch (e) {
                // Saltar errores parciales
            }
        });

        res.json({
            busquedaOriginal: queryUsuario,
            totalCanciones: listaCanciones.length,
            canciones: listaCanciones
        });
    });
});

/**
 * RUTA PARA OBTENER EL ENLACE DIRECTO DE AUDIO (STREAMING)
 */
app.get('/api/stream', (req, res) => {
    const videoId = req.query.id;
    if (!videoId) return res.status(400).json({ error: "Falta el ID del video" });

    const videoUrl = `https://youtube.com{videoId}`;
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

app.listen(PORT, () => {
    console.log(`Neon Music Server corriendo con éxito en el puerto ${PORT}`);
});
