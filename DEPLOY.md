# Deploying Word Rush

The app is a single Node.js process serving static files and WebSockets. No database, API key, or external service is required.

## Option 1: Render (recommended)

Render serves WebSockets on the same domain and provisions HTTPS automatically.

### Deploy from a GitHub repository

1. Push this project to a GitHub repository.
2. In the Render dashboard, choose **New → Blueprint** and select the repository.
   `render.yaml` creates a Node web service with:
   - Build command: `npm ci`
   - Start command: `npm start`
   - Health check: `/healthz`
3. Wait for the deploy and open the `https://<service>.onrender.com` URL.
4. To use your domain, open the service’s **Settings → Custom Domains**, add `play.yourdomain.com`, and copy the CNAME target Render shows (usually `<service>.onrender.com`).
5. Add the DNS record at your registrar:
   - **GoDaddy:** DNS → Add → CNAME. Name `play`, value: the Render target, TTL 1 hour.
   - **Namecheap:** Advanced DNS → Add New Record → CNAME Record. Host `play`, target: the Render target, TTL Automatic.
6. Wait for DNS to propagate. Render will issue an SSL certificate for the custom domain.
7. Optionally set `PUBLIC_URL=https://play.yourdomain.com` in Render’s environment variables. QR codes already use the request origin, so this is only a fallback.

Use a subdomain such as `play.yourdomain.com`. Most registrars do not support a CNAME at the bare apex; for the bare domain, use registrar forwarding to `www`/`play` or move DNS to a provider that supports apex flattening.

### Free-tier note

Render’s free web service sleeps after a period of inactivity. The first visitor may wait 30–60 seconds for a cold start. For a party or a judged demo, use a paid always-on instance or open the link once shortly before playing.

### Useful Render settings

- Environment: Node 20+ (Node 22 is fine).
- Health check path: `/healthz`.
- Do not enable multiple instances; rooms are stored in memory.

## Option 2: Docker on any VPS

```bash
docker build -t word-rush .
docker run -d --name word-rush --restart=always -p 8080:8080 -e PORT=8080 word-rush
```

Put Nginx in front for HTTPS and WebSocket forwarding:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
}
```

Get a certificate with Certbot, then point an A record at the VPS IP:

- **GoDaddy:** DNS → A record, name `play`, value: server IP.
- **Namecheap:** Advanced DNS → A Record, host `play`, value: server IP.

## Option 3: Temporary public tunnel

For a playtest right now:

```bash
npm start
cloudflared tunnel --url http://localhost:3000
```

Cloudflare prints a temporary `https://<random>.trycloudflare.com` URL. WebSockets and QR codes work. This link changes when the tunnel restarts and is not suitable as a permanent submission link.

## Health check

```bash
curl https://your-domain/healthz
```

Expected response:

```json
{ "ok": true, "rooms": 0, "uptimeSeconds": 12 }
```

## Operational notes

- Rooms are in memory and disappear when the process restarts.
- The app supports one Node instance. A multi-instance deployment needs shared room state and WebSocket pub/sub.
- Room codes are 4 characters; capacity is 10 players per room.
- No secrets are read by the application. `PORT`, `HOST`, and optional `PUBLIC_URL` are the only environment variables.
