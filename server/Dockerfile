FROM node:22-alpine AS build
# Prisma's migration engine links against OpenSSL.
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# Keep the engine binaries `npm ci` downloaded, drop the dev tools.
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/prisma.config.ts ./
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8000
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && exec node dist/server.js"]
