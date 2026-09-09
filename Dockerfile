FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir .
RUN useradd --create-home --uid 10001 bot && mkdir -p /app/data && chown -R bot:bot /app
USER bot
CMD ["kernel-build-bot"]

