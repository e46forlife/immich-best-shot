FROM node:20-bookworm-slim

WORKDIR /app

# Install deps
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Run
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
