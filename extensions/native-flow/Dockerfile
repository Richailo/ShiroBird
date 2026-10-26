FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN python -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=. flow.proto \
    && mkdir /data && chown 65532:65532 /data
USER 65532:65532
EXPOSE 8084 8085
CMD ["python", "receiver.py"]
