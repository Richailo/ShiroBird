FROM python:3.13-slim
LABEL org.opencontainers.image.title="ShiroBird Customize"
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY shirobird/ /app/shirobird/
COPY integration/customize_service.py /app/customize_service.py
RUN mkdir -p /data && chown 65532:65532 /data
USER 65532:65532
EXPOSE 8777
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8777/healthz',timeout=3)"
CMD ["python3", "/app/customize_service.py"]
