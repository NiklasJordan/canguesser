FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3099 \
    DB_PATH=/data/scores.db

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3099

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3099/healthz || exit 1

# node:sqlite is built in (Node 22.13+); silence its experimental notice
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
