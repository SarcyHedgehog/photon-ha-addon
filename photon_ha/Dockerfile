FROM ghcr.io/home-assistant/amd64-base:3.22

ARG BUILD_VERSION
ARG BUILD_ARCH

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="addon" \
  io.hass.arch="${BUILD_ARCH}"

RUN apk add --no-cache nodejs npm

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY photon-bridge.mjs admin-app.js admin.html styles.css addon-entry.mjs ./
COPY exposed-entities.example.json ./
COPY vendor ./vendor
COPY run.sh /run.sh

RUN chmod a+x /run.sh

CMD ["/run.sh"]
