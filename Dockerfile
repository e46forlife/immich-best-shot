# ---------- build stage ----------
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Install deps (dev deps included so tsc is available)
COPY package*.json ./
RUN npm install

# Copy source and build
COPY . .
RUN npm run build

# ---------- runtime stage ----------
FROM node:20-bookworm-slim AS runner
WORKDIR /app

# Copy only what's needed to run
COPY --from=builder /app/dist ./dist
COPY package*.json ./

# Install only production deps (none in our minimal app, but harmless)
RUN npm install --omit=dev

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
