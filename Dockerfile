FROM node:20-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip ca-certificates \
    && pip3 install --break-system-packages --no-cache-dir yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /tmp/clipforge
CMD ["npm", "start"]
