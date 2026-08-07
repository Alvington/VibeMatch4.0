# Stage 1: Build Stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files AND the prisma schema first
COPY package*.json ./
COPY prisma ./prisma

# Install ALL dependencies
RUN npm ci

# Force install typescript globally to ensure tsc works
RUN npm install -g typescript

# Copy the rest of the application code
COPY . .

# Build the TypeScript code
RUN tsc

# Stage 2: Production Stage
FROM node:20-alpine AS production

WORKDIR /app

# Copy package files and prisma schema again
COPY package*.json ./
COPY prisma ./prisma

# Install only production dependencies
RUN npm ci --omit=dev && npm cache clean --force

# Copy the compiled JavaScript code
COPY --from=builder /app/dist ./dist

# Copy public assets
COPY --from=builder /app/public ./public

# Security: Run as node user
USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
