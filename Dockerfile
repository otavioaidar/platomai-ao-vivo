FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY certs ./certs
COPY editorial ./editorial
COPY public ./public
COPY src ./src
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/aovivo.db
VOLUME /data
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
