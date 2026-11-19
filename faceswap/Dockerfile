# StillGPT faceswap sidecar (CPU, linux/arm64 + amd64). Models are NOT baked in: they are downloaded on first
# start into /models (named volume faceswap_models) and sha256-verified.
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    FACESWAP_MODEL_DIR=/models \
    PORT=8080

WORKDIR /app
COPY requirements.txt .
# all deps ship manylinux wheels for aarch64/x86_64 -> no compiler needed
RUN pip install --only-binary=:all: -r requirements.txt \
    && useradd --uid 10001 --create-home --shell /usr/sbin/nologin faceswap \
    && mkdir -p /models && chown faceswap:faceswap /models

COPY app ./app

USER faceswap
EXPOSE 8080
VOLUME ["/models"]

# Long start period: the first start downloads ~1.4 GB of models.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30m --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health/ready', timeout=4).status == 200 else 1)"

CMD ["python", "-m", "app"]
