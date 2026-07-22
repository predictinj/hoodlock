# HoodLock — static site. Build the Vite app, then serve web/dist. No backend:
# the app reads all lock state straight from Robinhood Chain.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci needs a lock in sync; fall back to npm install so the build is robust.
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
# Bump CACHEBUST to force the source copy + Vite build to re-run (invalidates buildkit cache).
ARG CACHEBUST=3
COPY . .
RUN npx vite build web

FROM node:20-slim
WORKDIR /app
RUN npm i -g serve@14
COPY --from=build /app/web/dist ./dist
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "serve -s dist -l ${PORT}"]
