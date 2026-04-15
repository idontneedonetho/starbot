FROM node:22-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN npm run build

FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /app

# Install ONLY production dependencies to keep image small
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Environment settings (can be overridden by docker-compose)
ENV NODE_ENV=production

# Run compiled JS. Avoid wrapping node in "npm run" for correct OS signal handling.
CMD ["node", "dist/index.js"]
