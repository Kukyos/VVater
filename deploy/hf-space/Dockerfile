# The API on a Hugging Face Docker Space. The Space holds only this file and README.md;
# the code is cloned from GitHub at build time, so a "Factory rebuild" deploys main.
FROM python:3.14-slim

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# Spaces run the container as uid 1000; data/cache must be writable by it.
RUN useradd -m -u 1000 user
USER user
WORKDIR /home/user

# Changes whenever main moves, which invalidates the clone below instead of reusing a
# stale layer.
ADD --chown=user https://api.github.com/repos/Kukyos/VVater/git/refs/heads/main /tmp/main.json
RUN git clone --depth 1 https://github.com/Kukyos/VVater.git app
WORKDIR /home/user/app
RUN pip install --no-cache-dir --user -r server/requirements.txt

ENV PATH="/home/user/.local/bin:$PATH" MALLOC_ARENA_MAX=2
EXPOSE 7860
CMD ["uvicorn", "server.ocean.api:app", "--host", "0.0.0.0", "--port", "7860"]
