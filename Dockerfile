FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Copy .env.example for reference
COPY .env.example .env.example

# Data directory for wiki clone and persistence
RUN mkdir -p data/docs data/data

# Run the bot
CMD ["node", "--no-warnings", "--import=tsx", "src/index.ts"]