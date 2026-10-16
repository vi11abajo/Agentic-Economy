# Build context: repository root.  docker build -f services/prosper-monitor/deploy/Dockerfile .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/pharos-mcp packages/pharos-mcp
COPY services/prosper-monitor services/prosper-monitor
# Only the two workspaces this service needs.
RUN node -e "const p=require('./package.json'); p.workspaces=['packages/pharos-mcp','services/prosper-monitor']; require('fs').writeFileSync('package.json', JSON.stringify(p))" \
 && npm install --no-fund --no-audit \
 && npm run build -w packages/pharos-mcp \
 && npm run build -w services/prosper-monitor \
 && npm prune --omit=dev --no-fund --no-audit

FROM node:22-slim
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/prosper.db
WORKDIR /app
COPY --from=build /app /app
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "--no-warnings", "services/prosper-monitor/dist/main.js"]
