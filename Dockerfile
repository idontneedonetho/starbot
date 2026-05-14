FROM node:22-slim

WORKDIR /app

# Install git (needed by simple-git) + ONNX Runtime deps (needed by @huggingface/transformers)
RUN apt-get update && apt-get install -y \
    git \
    libgomp1 \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

# Install TypeScript globally so we can build without dev deps in the final image
RUN npm install -g typescript

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# Keep only production dependencies
RUN npm ci --omit=dev && npm cache clean --force

CMD ["node", "dist/index.js"]
