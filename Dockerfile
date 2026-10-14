FROM node:22-bookworm-slim

# Chromium (puppeteer-core er jonno) + font
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .
RUN chown node:node /usr/src/app

ENV NODE_ENV=production
ENV CHROME_PATH=/usr/bin/chromium

USER node
EXPOSE 8090

CMD ["node", "index.js"]