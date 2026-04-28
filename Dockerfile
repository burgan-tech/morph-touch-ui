# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html eslint.config.js ./
COPY src ./src

RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

RUN addgroup -S app && adduser -S app -G app

COPY --from=builder /app/dist ./dist
COPY server.js ./server.js
COPY package.json ./package.json

USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:${PORT}/ >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
