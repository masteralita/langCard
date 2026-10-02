FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js db.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/langcard.db
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
