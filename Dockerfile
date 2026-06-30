FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    DEBIAN_FRONTEND=noninteractive \
    UV_NO_CACHE=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml uv.lock .python-version ./
RUN pip install --no-cache-dir uv \
    && uv sync --frozen --no-dev --no-cache

COPY src ./src
COPY db ./db
COPY sample ./sample

CMD ["sh", "-c", "exec .venv/bin/uvicorn src.backend.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
