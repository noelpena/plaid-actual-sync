FROM node:22-alpine

# Install dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install npm dependencies
RUN npm install

# Optional: install a specific @actual-app/api version instead of the one in
# package.json. CI sets this to the latest stable release; set it yourself when
# building from source against an older Actual setup.
ARG ACTUAL_VERSION=
RUN if [ -n "$ACTUAL_VERSION" ]; then npm install --no-save "@actual-app/api@$ACTUAL_VERSION"; fi

# Copy application files
COPY . .

# Create necessary directories
RUN mkdir -p /app/config \
    /app/logs \
    /app/transaction-data \
    /app/static

# Set permissions
RUN chmod -R 755 /app

# Expose port
EXPOSE 8001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8001/ping', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
CMD ["node", "server.js"]