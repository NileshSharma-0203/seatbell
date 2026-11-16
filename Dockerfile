FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# npm ci needs the lockfile; fall back so a first build works before you commit one.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

FROM node:22-slim
ENV NODE_ENV=production
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY migrations ./migrations
COPY public ./public
COPY src ./src
USER node
EXPOSE 3000
CMD ["node", "src/web/main.ts"]
