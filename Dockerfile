FROM node:22-alpine

# Install git, required by simple-git for repository synchronization
RUN apk add --no-cache git

WORKDIR /app

# Install dependencies first to maximize Docker layer caching
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the application files
COPY . .

# Build TypeScript to the dist/ directory
RUN npm run build

# Environment settings (can be overridden by docker-compose)
ENV NODE_ENV=production

CMD ["npm", "start"]
