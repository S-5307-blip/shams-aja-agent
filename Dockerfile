# syntax=docker/dockerfile:1

FROM node:24-alpine AS dependencies
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN npm ci

FROM dependencies AS builder
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-alpine AS runner
RUN apk add --no-cache libc6-compat openssl \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=dependencies --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --chown=nextjs:nodejs package.json package-lock.json tsconfig.json ./
COPY --chown=nextjs:nodejs prisma ./prisma
COPY --chown=nextjs:nodejs src/lib ./src/lib
COPY --chown=nextjs:nodejs scripts ./scripts

USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1
# Migrations run on every start; they are idempotent and the schema stays in step with the code.
CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]
