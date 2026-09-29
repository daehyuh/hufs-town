FROM node:24.14.1-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY test ./test
RUN mkdir -p /data/recordings && chown node:node /data/recordings
USER node
ENV NODE_ENV=production
CMD ["node", "src/server.mjs"]
