# Stage 1: Build
FROM node:24-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

COPY package*.json ./
COPY packages ./packages
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: Production
FROM node:24-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

# Install runtime dependencies for native modules
RUN apk add --no-cache python3 make g++

COPY package*.json ./
COPY packages ./packages
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY lexicons ./lexicons

EXPOSE 3005

CMD ["node", "dist/index.js"]
