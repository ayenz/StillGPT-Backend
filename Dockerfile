# syntax=docker/dockerfile:1
# Multi-arch (linux/arm64 for oracle-server, amd64 elsewhere).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild esbuild
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# ffmpeg: still frames for video thumbnails/posters (GET /media/:id?variant=thumb|preview).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=8790 MEDIA_DIR=/data/media
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY package.json ./
RUN mkdir -p /data/media && chown -R node:node /data
USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
