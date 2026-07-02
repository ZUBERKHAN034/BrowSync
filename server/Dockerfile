FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --only=production

COPY src/ ./src/
COPY data/ ./data/

RUN mkdir -p /app/data

VOLUME ["/app/data"]

EXPOSE 62333

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=62333
ENV DATA_DIR=/app/data

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:62333/health || exit 1

USER node

CMD ["node", "src/server.js"]
