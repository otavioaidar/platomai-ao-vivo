# Needs Node 24.5+ (tls.setDefaultCACertificates). Build with --pull so a stale local node:24 image is not reused.
FROM node:24-slim
# pdftotext reads the text of CVM filings (fatos relevantes); without it they go out with the subject only.
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY certs ./certs
COPY editorial ./editorial
COPY public ./public
COPY src ./src
# The latency report reads the same database: docker exec aovivo node --disable-warning=ExperimentalWarning scripts/latencia.ts
COPY scripts/latencia.ts ./scripts/latencia.ts
# The database lives on the /data volume, owned by the unprivileged node user; the code stays read-only for it.
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/aovivo.db
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
