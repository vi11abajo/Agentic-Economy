# Build context: repository root.  docker build -f 12-tabkeeper/deploy/Dockerfile .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY 11-harborpilot 11-harborpilot
COPY 12-tabkeeper 12-tabkeeper
# Only the two workspaces the sellers need (the Harbor data comes from harborpilot's adapters).
RUN node -e "const p=require('./package.json'); p.workspaces=['11-harborpilot','12-tabkeeper']; require('fs').writeFileSync('package.json', JSON.stringify(p))" \
 && npm install --no-fund --no-audit \
 && npx -w 11-harborpilot tsc \
 && npx -w 12-tabkeeper tsc \
 && npm prune --omit=dev --no-fund --no-audit

FROM node:22-slim
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY --from=build /app /app
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "--no-warnings", "12-tabkeeper/dist/seller/server.js"]
