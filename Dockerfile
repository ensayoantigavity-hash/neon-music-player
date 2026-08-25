FROM node:20-slim

# Instala Python (para yt-dlp), ffmpeg (para descargas MP3) y certificados HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates ffmpeg \
 && update-ca-certificates \
 && ln -sf /usr/bin/python3 /usr/local/bin/python \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# yt-dlp es quien resuelve el audio de YouTube sin anuncios.
RUN python3 -m pip install --no-cache-dir --break-system-packages yt-dlp imageio-ffmpeg \
 || python3 -m pip install --no-cache-dir yt-dlp imageio-ffmpeg

ENV PORT=8765
EXPOSE 8765

CMD ["node", "server.js"]
