FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
WORKDIR /build
COPY services/maritime-agent/package.json services/maritime-agent/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY services/maritime-agent/src ./services/maritime-agent/src
COPY packages/shared/maritime-coordination.ts ./packages/shared/maritime-coordination.ts
RUN ./node_modules/.bin/esbuild services/maritime-agent/src/server.ts --bundle --platform=node --format=esm --target=node22 --outfile=dist/server.mjs

FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
WORKDIR /app
RUN test -s /etc/ssl/cert.pem && mkdir -p /data/jeevika && chown node:node /data/jeevika
COPY --from=build --chown=node:node /build/dist/server.mjs ./server.mjs
USER node
VOLUME ["/data"]
CMD ["node", "server.mjs"]
