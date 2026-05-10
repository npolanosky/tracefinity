# Single container with frontend + backend
# Build: docker build -t tracefinity .
# Run: docker run -p 3000:3000 -v ./data:/app/storage tracefinity
# Run as host user: docker run -p 3000:3000 -v ./data:/app/storage --user "$(id -u):$(id -g)" tracefinity

FROM node:20-slim AS frontend-build

RUN corepack enable pnpm

WORKDIR /frontend
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
ENV NEXT_PUBLIC_API_URL=
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm run build

FROM python:3.12-slim

RUN apt-get update && \
    apt-get install -y \
    libgl1 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libheif-dev \
    nodejs \
    nginx \
    supervisor \
    git \
    && (apt-get install -y libglib2.0-0t64 2>/dev/null || apt-get install -y libglib2.0-0) \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# backend
COPY backend/requirements.txt ./backend/
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir -r backend/requirements.txt

# Swap CPU onnxruntime for the GPU build so the ONNX tracers (isnet,
# birefnet-*) run on an NVIDIA GPU. CPU torch is fine — those tracers use
# onnxruntime, not torch. The [cuda,cudnn] extras ship CUDA 12 / cuDNN 9 as
# pip wheels, so the slim base only needs the host driver (via
# nvidia-container-toolkit). onnxruntime-gpu conflicts with onnxruntime, so
# uninstall first rather than installing requirements-gpu.txt alongside it.
RUN pip uninstall -y onnxruntime \
 && pip install --no-cache-dir "onnxruntime-gpu[cuda,cudnn]>=1.23.0"

COPY backend/ ./backend/

# Pre-warm the model caches so cold starts skip ~30s of GitHub downloads.
# rembg models land in /root/.u2net/, transparent_background's InSPyReNet
# weights in /root/.transparent-background/. Adds ~500MB to image size in
# exchange for boots that take ~30s instead of ~70s on a fresh container.
RUN cd /app/backend && python -c "\
from rembg import new_session; \
print('warming u2netp...'); new_session('u2netp'); \
print('warming isnet-general-use...'); new_session('isnet-general-use'); \
print('warming birefnet-general-lite...'); new_session('birefnet-general-lite'); \
print('warming inspyrenet...'); \
from transparent_background import Remover; Remover(mode='base', device='cpu'); \
" && echo 'cache sizes:' && du -sh /root/.u2net /root/.transparent-background 2>/dev/null || true

# frontend (built)
COPY --from=frontend-build /frontend/.next ./.next
COPY --from=frontend-build /frontend/public ./public
COPY --from=frontend-build /frontend/package.json ./
COPY --from=frontend-build /frontend/node_modules ./node_modules

# storage directory
RUN mkdir -p /app/storage/uploads /app/storage/processed /app/storage/outputs

# non-root user (UID 1000). --user flag can override with any UID.
RUN groupadd -r -g 1000 tracefinity && \
    useradd -r -u 1000 -g tracefinity -d /app -s /sbin/nologin tracefinity

# model cache inside /app so it's writable by any user
RUN mkdir -p /app/.u2net

# nginx: move pid and logs to /tmp so non-root can write them
RUN rm -f /etc/nginx/sites-enabled/default
COPY <<'NGINX_EOF' /etc/nginx/sites-enabled/tracefinity.conf
server {
    listen 3000;
    client_max_body_size 25m;

    # boot status file: written by the backend at import time and served by
    # nginx so the frontend can show progress before uvicorn binds to :8000.
    # Always no-cache; missing file is treated as "not ready yet".
    location = /boot.json {
        alias /tmp/tracefinity_boot.json;
        default_type application/json;
        add_header Cache-Control "no-store, max-age=0";
        try_files $uri =503;
    }

    # api + storage -> uvicorn (120s timeout for STL generation)
    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_read_timeout 120s;
        proxy_connect_timeout 10s;
        proxy_send_timeout 30s;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /storage/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
    }

    # everything else -> next.js
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
NGINX_EOF

# nginx non-root: pid in /tmp, disable default error_log (supervisor captures it)
RUN sed -i 's|pid /run/nginx.pid;|pid /tmp/nginx/nginx.pid;|' /etc/nginx/nginx.conf && \
    sed -i '/^user /d' /etc/nginx/nginx.conf

# supervisor config
COPY <<SUPERVISOR_EOF /etc/supervisor/conf.d/tracefinity.conf
[supervisord]
nodaemon=true
pidfile=/tmp/supervisor/supervisord.pid
logfile=/tmp/supervisor/supervisord.log
childlogdir=/tmp/supervisor

[program:nginx]
command=nginx -g "daemon off;"
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0

[program:backend]
command=uvicorn app.main:app --host 127.0.0.1 --port 8000
directory=/app/backend
environment=STORAGE_PATH="/app/storage"
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0

[program:frontend]
command=node_modules/.bin/next start
directory=/app
environment=PORT="3001",BACKEND_URL="http://127.0.0.1:8000"
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
SUPERVISOR_EOF

# make all runtime-writable directories accessible to any UID
RUN chmod -R 777 /app/storage /app/.u2net /app/.next && \
    chmod -R 777 /var/lib/nginx /var/log/nginx && \
    mkdir -p /tmp/nginx /tmp/supervisor && chmod 777 /tmp/nginx /tmp/supervisor

# entrypoint handles directory creation for arbitrary UIDs
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

ENV GEMINI_IMAGE_MODEL="gemini-3-pro-image-preview"
ENV STORAGE_PATH=/app/storage
ENV U2NET_HOME=/app/.u2net
ENV NUMBA_CACHE_DIR=/tmp/numba_cache
ENV HOME=/app

USER tracefinity

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["supervisord", "-c", "/etc/supervisor/conf.d/tracefinity.conf"]
