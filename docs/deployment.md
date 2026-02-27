# Deploying ALF

This guide covers running ALF in production across several common platforms.

> **Important:** `SERVICE_URL` must be an HTTPS URL in all production deployments. ATProto OAuth requires that ALF's client metadata be served over HTTPS. Without a valid HTTPS `SERVICE_URL`, the OAuth authorization flow will fail.

---

## Environment variable reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3005` | HTTP port ALF listens on |
| `SERVICE_URL` | **Yes (production)** | `http://localhost:3005` | Public HTTPS URL of this deployment |
| `ENCRYPTION_KEY` | **Yes** | — | 64-char hex string (32 bytes) for AES-256-GCM encryption of stored tokens |
| `DATABASE_TYPE` | No | `sqlite` | `sqlite` or `postgres` |
| `DATABASE_PATH` | No | `./data/alf.db` | SQLite file path (ignored when using Postgres) |
| `DATABASE_URL` | If postgres | — | PostgreSQL connection string |
| `PLC_ROOT` | No | `https://plc.directory` | ATProto PLC directory |
| `HANDLE_RESOLVER_URL` | No | `https://api.bsky.app` | Handle-to-DID resolver |
| `POST_PUBLISH_WEBHOOK_URL` | No | — | URL to POST to after each successful publish |

Generate an encryption key before any deployment:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Store the resulting 64-character hex string as `ENCRYPTION_KEY`. Treat it like a private key — if it is lost, all stored OAuth tokens become unreadable.

---

## Docker (standalone)

### Prerequisites

- Docker installed and running
- A domain with HTTPS (or a reverse proxy such as Caddy or nginx providing TLS termination in front of port 3005)

### Steps

```bash
# 1. Build the image
git clone https://github.com/your-org/alf.git
cd alf
docker build -t alf .

# 2. Create a data directory for the SQLite database
mkdir -p ./data

# 3. Run the container
docker run -d \
  --name alf \
  --restart unless-stopped \
  -p 3005:3005 \
  -e ENCRYPTION_KEY=your-64-char-hex-key \
  -e SERVICE_URL=https://alf.example.com \
  -e DATABASE_TYPE=sqlite \
  -e DATABASE_PATH=/data/alf.db \
  -v $(pwd)/data:/data \
  alf

# 4. Verify
curl https://alf.example.com/health
# {"status":"ok","service":"alf"}
```

### Using PostgreSQL instead of SQLite

```bash
docker run -d \
  --name alf \
  --restart unless-stopped \
  -p 3005:3005 \
  -e ENCRYPTION_KEY=your-64-char-hex-key \
  -e SERVICE_URL=https://alf.example.com \
  -e DATABASE_TYPE=postgres \
  -e DATABASE_URL=postgresql://user:pass@db.example.com:5432/alf \
  alf
```

### Production checklist

- `SERVICE_URL` is set to your public HTTPS URL
- `ENCRYPTION_KEY` is a securely generated 64-char hex string
- The `/data` volume (or Postgres) is backed up regularly
- A reverse proxy handles TLS in front of port 3005

---

## Docker Compose

The repository includes a `docker-compose.yml` that runs ALF with a persistent named volume for the SQLite database.

### Prerequisites

- Docker and Docker Compose v2 installed
- A domain with HTTPS termination (handled externally — the Compose file exposes port 3005)

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/your-org/alf.git
cd alf

# 2. Create your .env file
cp .env.example .env
```

Edit `.env` and set at minimum:

```dotenv
ENCRYPTION_KEY=your-64-char-hex-key
SERVICE_URL=https://alf.example.com
```

For Postgres, also set:

```dotenv
DATABASE_TYPE=postgres
DATABASE_URL=postgresql://user:pass@db.example.com:5432/alf
```

```bash
# 3. Start ALF
docker compose up -d

# 4. Verify
curl http://localhost:3005/health
# {"status":"ok","service":"alf"}
```

### Updating

```bash
git pull
docker compose build
docker compose up -d
```

### Production checklist

- `SERVICE_URL` is set to your public HTTPS URL in `.env`
- `.env` is not committed to version control
- `ENCRYPTION_KEY` is a securely generated 64-char hex string
- The `alf-data` named volume is included in your backup strategy
- TLS is terminated upstream (nginx, Caddy, Traefik, etc.)

---

## Fly.io

### Prerequisites

- [`flyctl`](https://fly.io/docs/hands-on/install-flyctl/) installed and authenticated (`fly auth login`)
- A Fly.io account

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/your-org/alf.git
cd alf

# 2. Create a new Fly app (accept defaults or customise as prompted)
fly launch

# 3. Set secrets (never put these in fly.toml)
fly secrets set ENCRYPTION_KEY=your-64-char-hex-key
fly secrets set SERVICE_URL=https://alf.your-app.fly.dev

# If using Postgres:
fly secrets set DATABASE_TYPE=postgres
fly secrets set DATABASE_URL=postgresql://user:pass@your-fly-pg.internal:5432/alf

# 4. Deploy
fly deploy

# 5. Verify
curl https://alf.your-app.fly.dev/health
# {"status":"ok","service":"alf"}
```

### Persistent storage for SQLite

If you are using SQLite (the default), attach a Fly volume so the database survives restarts and deployments:

```bash
fly volumes create alf_data --region <your-region> --size 1
```

Add the following to your `fly.toml`:

```toml
[mounts]
  source = "alf_data"
  destination = "/data"
```

Then set `DATABASE_PATH=/data/alf.db` as a secret or in `fly.toml` under `[env]`.

For multi-region or multi-instance deployments, use Postgres (`fly postgres create`) rather than SQLite.

### Production checklist

- `SERVICE_URL` is set to your `https://your-app.fly.dev` URL (or custom domain with HTTPS)
- `ENCRYPTION_KEY` is set as a secret (not in `fly.toml`)
- A Fly volume or Fly Postgres is configured for persistence
- Health check passes: `fly status`

---

## Railway

### Prerequisites

- A [Railway](https://railway.app) account
- Your ALF repository pushed to GitHub

### Steps

1. Go to [railway.app](https://railway.app) and click **New Project**.
2. Select **Deploy from GitHub repo** and choose your ALF repository.
3. Railway will detect the `Dockerfile` and build automatically.
4. Click on your service, then go to **Variables** and add:

| Variable | Value |
|----------|-------|
| `ENCRYPTION_KEY` | your-64-char-hex-key |
| `SERVICE_URL` | `https://<your-railway-app>.up.railway.app` (set after domain is assigned) |
| `DATABASE_TYPE` | `sqlite` or `postgres` |
| `DATABASE_URL` | (if using Postgres — see below) |

5. To add a managed Postgres database: click **New** in your project, choose **Database > Add PostgreSQL**. Railway will inject `DATABASE_URL` automatically; you only need to set `DATABASE_TYPE=postgres`.

6. For SQLite persistence, add a **Volume** to your service and mount it at `/data`, then set `DATABASE_PATH=/data/alf.db`.

7. Once deployed, copy the public URL Railway assigns and update `SERVICE_URL` to that HTTPS URL.

8. Trigger a redeploy so the updated `SERVICE_URL` takes effect.

### Production checklist

- `SERVICE_URL` is set to the Railway-provided HTTPS URL or your custom domain
- `ENCRYPTION_KEY` is set in the Variables panel
- Persistent storage (volume or Postgres) is configured
- Health check URL (`/health`) is configured in the Railway service settings

---

## Render

### Prerequisites

- A [Render](https://render.com) account
- Your ALF repository pushed to GitHub

### Steps

1. Go to the Render dashboard and click **New > Web Service**.
2. Connect your GitHub repository.
3. Render will detect the `Dockerfile`. Set:
   - **Name:** `alf` (or your preferred name)
   - **Region:** choose the region closest to your users
   - **Instance type:** Starter or above (Starter is sufficient for low traffic)
4. Under **Environment Variables**, add:

| Key | Value |
|-----|-------|
| `ENCRYPTION_KEY` | your-64-char-hex-key |
| `SERVICE_URL` | `https://<your-render-app>.onrender.com` (update after deploy) |
| `DATABASE_TYPE` | `sqlite` or `postgres` |

5. For Postgres: click **New > PostgreSQL** in the Render dashboard to create a managed database. Copy the **Internal Database URL** into `DATABASE_URL` and set `DATABASE_TYPE=postgres`.

6. For SQLite persistence: add a **Disk** to your service, mounted at `/data`, with at least 1 GB. Then set `DATABASE_PATH=/data/alf.db`.

7. Click **Create Web Service**. After the first deploy completes, copy the Render-provided URL and update `SERVICE_URL` in your environment variables. Render will trigger an automatic redeploy.

### Production checklist

- `SERVICE_URL` is set to the Render-provided HTTPS URL or your custom domain
- `ENCRYPTION_KEY` is set in the environment variables panel
- A Render Disk (for SQLite) or Render PostgreSQL is attached
- The health check path is set to `/health` in the Render service settings

---

## Bare-metal / VPS

This section covers running ALF directly on a Linux server (Ubuntu, Debian, etc.) as a systemd service.

### Prerequisites

- Node.js 24 or later (required — ALF uses `"engines": { "node": ">=24" }`)
- npm 10 or later (bundled with Node 24)
- A reverse proxy (Caddy or nginx) for HTTPS termination
- A domain name pointed at your server's IP

### Install Node.js 24

```bash
# Using NodeSource (recommended)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

node --version   # should print v24.x.x
```

### Clone and build ALF

```bash
sudo mkdir -p /opt/alf
sudo chown $USER:$USER /opt/alf

git clone https://github.com/your-org/alf.git /opt/alf
cd /opt/alf

npm ci --omit=dev
npm run build
```

### Create a dedicated user

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin alf
sudo chown -R alf:alf /opt/alf

# Create the data directory
sudo mkdir -p /var/lib/alf
sudo chown alf:alf /var/lib/alf
```

### Configure environment

```bash
sudo nano /etc/alf/env
```

Set the following (create `/etc/alf/` first: `sudo mkdir -p /etc/alf`):

```dotenv
PORT=3005
SERVICE_URL=https://alf.example.com
ENCRYPTION_KEY=your-64-char-hex-key
DATABASE_TYPE=sqlite
DATABASE_PATH=/var/lib/alf/alf.db
# Or for Postgres:
# DATABASE_TYPE=postgres
# DATABASE_URL=postgresql://user:pass@localhost:5432/alf
PLC_ROOT=https://plc.directory
HANDLE_RESOLVER_URL=https://api.bsky.app
```

Restrict permissions on the env file:

```bash
sudo chmod 600 /etc/alf/env
sudo chown root:alf /etc/alf/env
```

### systemd unit file

Create `/etc/systemd/system/alf.service`:

```ini
[Unit]
Description=ALF — Atproto Latency Fabric
After=network.target

[Service]
Type=simple
User=alf
Group=alf
WorkingDirectory=/opt/alf
EnvironmentFile=/etc/alf/env
ExecStart=/usr/bin/node /opt/alf/dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=alf

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/alf

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable alf
sudo systemctl start alf
sudo systemctl status alf
```

View logs:

```bash
journalctl -u alf -f
```

### Reverse proxy with Caddy (recommended)

Install Caddy and add to `/etc/caddy/Caddyfile`:

```
alf.example.com {
    reverse_proxy localhost:3005
}
```

Caddy handles HTTPS automatically via Let's Encrypt. Reload:

```bash
sudo systemctl reload caddy
```

### Reverse proxy with nginx

```nginx
server {
    listen 80;
    server_name alf.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name alf.example.com;

    ssl_certificate     /etc/letsencrypt/live/alf.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/alf.example.com/privkey.pem;

    location / {
        proxy_pass         http://localhost:3005;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

Use `certbot --nginx -d alf.example.com` to obtain a Let's Encrypt certificate.

### Updating

```bash
cd /opt/alf
git pull
npm ci --omit=dev
npm run build
sudo systemctl restart alf
```

### Production checklist

- Node.js 24 or later is installed (`node --version`)
- `SERVICE_URL` is set to your public HTTPS URL
- `ENCRYPTION_KEY` is a securely generated 64-char hex string
- `/etc/alf/env` has permissions `600` (readable only by root and the `alf` user)
- `/var/lib/alf` is backed up regularly (contains the SQLite database)
- The systemd service is enabled and set to restart on failure
- A reverse proxy with TLS is in front of port 3005
- Health check passes: `curl https://alf.example.com/health`
