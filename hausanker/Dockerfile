ARG BUILD_FROM=ghcr.io/home-assistant/base:3.24-2026.11.0
FROM $BUILD_FROM

RUN apk add --no-cache python3 openssl

COPY rootfs /

RUN chmod a+x /etc/services.d/hausanker/run /etc/services.d/hausanker/finish

LABEL \
    org.opencontainers.image.title="Home Assistant App: HausAnker XR" \
    org.opencontainers.image.description="WebXR-Minimaltest: virtuelle Post-its mit persistenten Ankern"
