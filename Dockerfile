# HoodLock — Vite frontend + a small Node server that ALSO serves the static
# site (so the app can't go down from the affiliate/admin backend) and powers
# affiliate tracking against Robinhood Chain. Data persists on a Railway volume.

# ---- stage 1: build the frontend ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
# Bump CACHEBUST to force the source copy + Vite build to re-run.
ARG CACHEBUST=4
# WalletConnect/Reown project id — Vite inlines VITE_ vars AT BUILD TIME.
ARG VITE_WALLETCONNECT_PROJECT_ID
ENV VITE_WALLETCONNECT_PROJECT_ID=$VITE_WALLETCONNECT_PROJECT_ID
# Optional dedicated RPC (e.g. Alchemy/QuickNode/Chainstack) tried before the
# rate-limited public RPC. Unset → app just uses the public endpoint.
ARG VITE_RPC_URL
ENV VITE_RPC_URL=$VITE_RPC_URL
COPY . .
# Regenerate /docs from web/docs-src before bundling. The output is committed
# too, but building it here means a stale commit cannot ship.
RUN node web/docs-src/build.mjs
RUN npx vite build web

# ---- stage 2: runtime (server serves dist + api) ----
FROM node:20-slim
WORKDIR /app/server
# build tools in case better-sqlite3 has no prebuilt binary for this platform
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY server/package.json ./
RUN npm install --no-audit --no-fund --omit=dev
# every server module, not just the entrypoint — index.mjs imports logs.mjs
COPY server/*.mjs ./
# data files the modules read at import time (the splitter deploy artifact)
COPY server/*.json ./
# The server imports ../shared/merkle.mjs, so the directory has to exist in the
# image. It did not, which took the site down: the container crashed on an
# import that resolves fine in a checkout because the directory sits right
# there. The symlink is what lets /app/shared resolve "viem", since Node walks
# up from the importing file and would otherwise never look inside
# /app/server/node_modules.
COPY shared /app/shared
RUN ln -s /app/server/node_modules /app/node_modules
# the share-card fonts — *.mjs doesn't match a directory, and without these
# every generated card renders as an empty gradient
COPY server/fonts ./fonts
# the static build + the chain config the server needs (single source of truth)
COPY --from=build /app/web/dist ./public
COPY web/src/config.json ./config.json

# Prove the image can actually load the server before it is allowed to ship. The
# outage this guards against was a directory the runtime stage never copied: the
# build was green, the image was broken, and the failure only appeared as a
# container that stopped. A failed build never replaces a running container.
RUN node --input-type=module -e "await import('/app/server/airdrop.mjs'); await import('/app/server/airdrop-pages.mjs'); console.log('image imports ok')" 
ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.mjs"]
