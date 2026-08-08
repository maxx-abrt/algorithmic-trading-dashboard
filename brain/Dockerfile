# The learning sidecar. CPU-only PyTorch keeps the image small enough to build on a
# mini PC and leaves the GPU question entirely out of the picture.
FROM python:3.11-slim-bookworm AS runtime

WORKDIR /app/brain
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    OMP_NUM_THREADS=3 \
    MKL_NUM_THREADS=3 \
    TORCH_NUM_THREADS=3 \
    BRAIN_DATA_DIR=/app/engine/data

RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 curl \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
# The CPU wheel index keeps the image ~700 MB instead of ~3 GB.
RUN pip install --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple -r requirements.txt

COPY *.py ./

EXPOSE 8791
HEALTHCHECK --interval=30s --timeout=8s --start-period=60s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8791/health', timeout=5).status==200 else 1)"

# One worker: training is CPU-bound and the governor already serialises jobs.
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8791", "--workers", "1"]
