FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=8080

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml .python-version ./
COPY src ./src
COPY scripts ./scripts
COPY db ./db

RUN pip install --no-cache-dir uv \
    && uv sync --no-dev

CMD ["sh", "-c", "exec uv run uvicorn src.backend.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
