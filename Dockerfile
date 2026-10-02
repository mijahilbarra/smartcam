FROM quantumentangledandy/neolink:latest AS neolink

FROM node:20-bookworm-slim

# Install GStreamer runtime dependencies and codecs
RUN apt-get update && apt-get install -y --no-install-recommends \
    gstreamer1.0-tools \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-libav \
    libgstrtspserver-1.0-0 \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Copy Neolink binary
COPY --from=neolink /usr/local/bin/neolink /usr/local/bin/neolink

WORKDIR /app

# Copy dependency definitions and install
COPY package*.json ./
RUN npm install --omit=dev

# Copy configuration and source code
COPY neolink.toml ./neolink.toml
COPY src/ ./src/

ENV PORT=8080
ENV NODE_ENV=production
ENV NEOLINK_CONFIG_PATH=/app/neolink.toml

EXPOSE 8080

CMD ["node", "src/index.js"]
