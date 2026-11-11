# Build stage: compile TypeScript
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Runtime stage: only the compiled code and the runtime dependencies
FROM node:20-alpine
ENV NODE_ENV=production
ENV PORT=1234
WORKDIR /app
COPY package.json package-lock.json ./
# Optional dependencies are only y-websocket's LevelDB persistence, which is not used
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 1234
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://localhost:${PORT}/health" || exit 1
CMD ["node", "dist/index.js"]
