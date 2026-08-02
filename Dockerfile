FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY server/ ./server/
RUN cd server && npm install --omit=dev

COPY dashboard/ ./dashboard/

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server/server.js"]
