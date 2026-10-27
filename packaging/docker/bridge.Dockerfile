FROM nginx:stable-alpine
LABEL org.opencontainers.image.title="ShiroBird Dashboard Bridge"
COPY integration/nginx.conf /etc/nginx/conf.d/default.conf
COPY integration/bridge.js /usr/share/nginx/html/bridge.js
COPY integration/bridge.css /usr/share/nginx/html/bridge.css
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/shirobird-integration/bridge.js || exit 1
