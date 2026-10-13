FROM python:3.11-slim

COPY --from=ghcr.io/astral-sh/uv:0.13 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev

ENV PATH="/opt/venv/bin:$PATH" API_HOST=0.0.0.0 API_PORT=8000 \
    DATABASE_URL=sqlite:////data/investopen.db
VOLUME /data
EXPOSE 8000
CMD ["investopen-api"]
