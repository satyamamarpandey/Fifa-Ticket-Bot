# Production image for the FIFA ticket monitor.
FROM node:20-alpine

# Run as the built-in non-root user.
WORKDIR /app

# Install only production dependencies for a small, reproducible image.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# App source.
COPY app.js mockServer.js ./

USER node
ENV NODE_ENV=production

# The monitor is the default process; the mock server is for local testing.
CMD ["node", "app.js"]
