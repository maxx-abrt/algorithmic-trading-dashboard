FROM node:20-bookworm-slim AS deps
WORKDIR /app/frontend
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

FROM node:20-bookworm-slim AS build
WORKDIR /app/frontend
ENV NEXT_TELEMETRY_DISABLED=1
ARG ENGINE_ORIGIN=http://engine:8790
ENV ENGINE_ORIGIN=$ENGINE_ORIGIN
COPY --from=deps /app/frontend/node_modules ./node_modules
COPY . .
RUN yarn build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app/frontend
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 ENGINE_ORIGIN=http://engine:8790
COPY --from=build /app/frontend/package.json ./package.json
COPY --from=build /app/frontend/node_modules ./node_modules
COPY --from=build /app/frontend/.next ./.next
COPY --from=build /app/frontend/public ./public
COPY --from=build /app/frontend/next.config.mjs ./next.config.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["yarn", "serve"]
