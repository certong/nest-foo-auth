# syntax=docker/dockerfile:1

# Debian slim rather than Alpine. Prisma 7 no longer ships a native query
# engine (the client carries a WASM query compiler and talks to Postgres through
# node-postgres), so OpenSSL is no longer Prisma's requirement; it and
# ca-certificates stay for TLS to Neon. Generating and running on the same base
# image keeps the build and the runtime alike.
FROM node:24-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app


FROM base AS build
# package files first so the dependency layer caches independently of source.
COPY package.json package-lock.json ./
# --ignore-scripts: the root postinstall generates the Prisma client, and the
# schema is not in the image yet at this point. Generation stays the explicit
# step below, which is what keeps the dependency layer cacheable.
RUN npm ci --ignore-scripts
# Generate before copying the rest of the source: the client only depends on the
# schema, so editing a service does not invalidate this layer.
COPY prisma ./prisma
# Prisma 7 reads the schema's location from here, not from a default.
COPY prisma.config.ts ./
RUN npx prisma generate
COPY . .
RUN npm run build


FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY prisma ./prisma
# A fresh production-only install rather than pruning the build stage's tree —
# npm prune has a habit of taking the generated node_modules/.prisma with it.
# --ignore-scripts as well: the prisma CLI is a devDependency and is absent
# here, so the root postinstall would fail. The generated client arrives by COPY
# from the build stage instead, which is the only copy this image should have.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# The generated client, carried over from the build stage. @prisma/client is a
# runtime dependency and is already installed above; .prisma/client holds the
# generated client and its query compiler, which npm does not produce.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist

USER node

# Railway injects PORT and main.ts reads it; this is only the local default.
ENV PORT=3001
EXPOSE 3001

# node directly rather than `npm run start:prod`: npm adds a process to every
# cold start and does not reliably forward SIGTERM, so enableShutdownHooks()
# would never see Railway's stop signal. Keep in step with start:prod.
CMD ["node", "dist/src/main"]
