FROM node:20-bookworm-slim AS deps
WORKDIR /app/engine
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

FROM node:20-bookworm-slim AS runtime
WORKDIR /app/engine
ENV NODE_ENV=production PORT=8790 MYCROFT_DB_PATH=/app/engine/data/mycroft.sqlite
COPY --from=deps /app/engine/node_modules ./node_modules
COPY package.json yarn.lock tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p data backups && chown -R node:node /app/engine
USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:8790/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["yarn", "start"]
