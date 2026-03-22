# CrossingBroad Mirror Proxy

Full mirror proxy untuk **crossingbroad.com** dengan anti-duplikat SEO. Bisa deploy ke Railway, Render, VPS, atau Easypanel.

## Fitur Anti-Duplikat

- **Canonical tag** otomatis di-rewrite ke domain mirror
- **og:url, twitter:url** di-rewrite ke domain mirror
- **Semua internal link** (href, src, srcset, action) di-rewrite
- **JSON-LD structured data** di-rewrite
- **Sitemap.xml** otomatis di-rewrite URL-nya
- **robots.txt** custom dengan sitemap mirror
- **CSS url()** dan inline style di-rewrite
- **Redirect Location header** di-rewrite
- **data-\* attribute** yang mengandung URL source di-rewrite
- **Preconnect/dns-prefetch** ke source dihapus
- **In-memory cache** untuk performa

## Environment Variables

| Variable | Default | Keterangan |
|---|---|---|
| `SOURCE_HOST` | `www.crossingbroad.com` | Domain sumber |
| `MIRROR_DOMAIN` | `crossingbroad.xyz` | Domain mirror kamu (**wajib untuk production**) |
| `MIRROR_PROTO` | `https` | Protocol mirror |
| `PORT` | `3000` | Port server |
| `CACHE_TTL` | `300` | Cache TTL dalam detik |

## Deploy ke Railway

1. Push repo ini ke GitHub
2. Buka [railway.app](https://railway.app), buat project baru dari repo
3. Set environment variable:
   ```
   MIRROR_DOMAIN=crossingbroad.xyz
   MIRROR_PROTO=https
   ```
4. Railway otomatis detect `package.json` dan jalankan `npm start`

## Deploy ke Render

1. Push repo ke GitHub
2. Buka [render.com](https://render.com), buat **Web Service** baru
3. Connect repo, pilih:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Set environment variable:
   ```
   MIRROR_DOMAIN=crossingbroad.xyz
   MIRROR_PROTO=https
   ```

## Deploy ke VPS (Ubuntu/Debian)

```bash
# Clone repo
git clone https://github.com/USERNAME/crossingbroad.git
cd crossingbroad

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install dependencies
npm install --production

# Setup environment
cp .env.example .env
nano .env  # Isi MIRROR_DOMAIN dengan domain kamu

# Jalankan dengan PM2
sudo npm install -g pm2
pm2 start server.js --name crossingbroad-mirror
pm2 save
pm2 startup
```

### Nginx Reverse Proxy (VPS)

```nginx
server {
    listen 80;
    server_name crossingbroad.xyz;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

Kemudian setup SSL dengan Certbot:
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d crossingbroad.xyz
```

## Deploy ke Easypanel

1. Buat app baru di Easypanel
2. Pilih **Dockerfile** sebagai source
3. Connect repo GitHub
4. Set environment variable:
   ```
   MIRROR_DOMAIN=crossingbroad.xyz
   MIRROR_PROTO=https
   PORT=3000
   ```
5. Set port **3000**
6. Deploy

## Deploy dengan Docker (Manual)

```bash
docker build -t crossingbroad-mirror .
docker run -d \
  -p 3000:3000 \
  -e MIRROR_DOMAIN=crossingbroad.xyz \
  -e MIRROR_PROTO=https \
  --name crossingbroad-mirror \
  crossingbroad-mirror
```

## Health Check

```
GET /_health
```
Response: `{"status":"ok","source":"www.crossingbroad.com"}`

## Tips Google Search Console

1. **Set `MIRROR_DOMAIN`** ke domain custom kamu (wajib!)
2. Submit `https://crossingbroad.xyz/sitemap_index.xml` di Google Search Console
3. Pastikan canonical tag sudah mengarah ke domain mirror (cek view-source)
4. Request indexing manual di Google Search Console untuk halaman utama
5. Jangan submit domain source dan mirror bersamaan di GSC — hanya submit domain mirror