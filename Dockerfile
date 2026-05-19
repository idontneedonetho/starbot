FROM node:22-slim AS base

# Install ONNX Runtime deps (needed by @huggingface/transformers)
RUN apt-get update && apt-get install -y \
    libgomp1 \
    libstdc++6 \
    git \
    && rm -rf /var/lib/apt/lists/*

FROM base AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# Production image — only built output + production deps
FROM base AS production

WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist/ ./dist/

CMD ["node", "dist/index.js"]
