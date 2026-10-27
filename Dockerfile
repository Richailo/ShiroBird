FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY shirobird/ /app/shirobird/
COPY web/ /app/web/
RUN mkdir -p /data/siem && chown -R 65532:65532 /data
USER 65532:65532
EXPOSE 8666
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8666/healthz', timeout=3)"
CMD ["python3", "-m", "shirobird.server"]
