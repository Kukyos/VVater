FROM python:3.14-slim
WORKDIR /app
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt
COPY . .
ENV MALLOC_ARENA_MAX=2
EXPOSE 8000
CMD ["uvicorn", "server.ocean.api:app", "--host", "0.0.0.0", "--port", "8000"]
