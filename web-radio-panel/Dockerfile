FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src/ ./src/
COPY public/ ./public/
COPY migrations/ ./migrations/
# Raiz de upload das fotos DVIR (montada como volume pelo host).
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads
EXPOSE 8601
USER node
CMD ["node", "src/server.js"]
