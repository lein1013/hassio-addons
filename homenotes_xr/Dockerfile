ARG BUILD_FROM=ghcr.io/home-assistant/base:3.24-2026.11.0
FROM $BUILD_FROM

RUN apk add --no-cache python3 openssl

COPY rootfs /

RUN chmod a+x /etc/services.d/homenotes/run /etc/services.d/homenotes/finish

LABEL \
    org.opencontainers.image.title="Home Assistant App: Home Notes XR" \
    org.opencontainers.image.description="Post-its und Video-Anleitungen in Mixed Reality"
