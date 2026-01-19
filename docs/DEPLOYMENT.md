# Deployment Guide

## Local Development

### Prerequisites

- Node.js 18+
- npm or yarn

### Setup

```bash
# Clone and install
git clone <repo-url>
cd mass_comms
npm install

# Configure environment
cp .env.local.example .env.local
# Edit .env.local with your API keys

# Initialize database
npx prisma migrate dev

# Start development server
npm run dev
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| DATABASE_URL | Yes | SQLite path (e.g., `file:./dev.db`) |
| ANTHROPIC_API_KEY | Yes | Claude API key from Anthropic |
| RESEND_API_KEY | Yes | Resend API key |
| RESEND_FROM_EMAIL | Yes | Verified sender email |

---

## Vercel Deployment

### Option 1: Vercel with SQLite (Turso)

SQLite doesn't work directly on Vercel's serverless functions. Use [Turso](https://turso.tech/) for a hosted SQLite-compatible database.

**Steps:**

1. Create a Turso account and database
2. Get your database URL and auth token
3. Update Prisma schema:

```prisma
datasource db {
  provider = "sqlite"
  url      = env("TURSO_DATABASE_URL")
}
```

4. Deploy to Vercel:

```bash
npm i -g vercel
vercel
```

5. Add environment variables in Vercel dashboard:
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
   - `ANTHROPIC_API_KEY`
   - `RESEND_API_KEY`
   - `RESEND_FROM_EMAIL`

### Option 2: Vercel with PostgreSQL

For production, consider switching to PostgreSQL:

1. Create a PostgreSQL database (Vercel Postgres, Supabase, Neon, etc.)

2. Update Prisma schema:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

3. Regenerate Prisma client:

```bash
npx prisma generate
npx prisma migrate deploy
```

4. Deploy to Vercel with `DATABASE_URL` pointing to PostgreSQL.

---

## Docker Deployment

### Dockerfile

```dockerfile
FROM node:18-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:18-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:18-alpine AS runner
WORKDIR /app
ENV NODE_ENV production
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

EXPOSE 3000
ENV PORT 3000
CMD ["node", "server.js"]
```

### docker-compose.yml

```yaml
version: '3.8'
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=file:/app/data/prod.db
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - RESEND_API_KEY=${RESEND_API_KEY}
      - RESEND_FROM_EMAIL=${RESEND_FROM_EMAIL}
    volumes:
      - ./data:/app/data
```

### Build and Run

```bash
# Build image
docker build -t mass-comms .

# Run with env file
docker run -p 3000:3000 --env-file .env.local mass-comms

# Or with docker-compose
docker-compose up -d
```

---

## Self-Hosted (VPS)

### Using PM2

```bash
# Install PM2
npm install -g pm2

# Build the app
npm run build

# Start with PM2
pm2 start npm --name "mass-comms" -- start

# Save PM2 config
pm2 save
pm2 startup
```

### Nginx Reverse Proxy

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### SSL with Certbot

```bash
sudo certbot --nginx -d your-domain.com
```

---

## Environment Security

### Production Checklist

- [ ] All API keys are environment variables (not in code)
- [ ] `.env` files are in `.gitignore`
- [ ] Database is not publicly accessible
- [ ] HTTPS is enabled
- [ ] Resend domain is verified for production email

### Secrets Management

For production, use a secrets manager:

- **Vercel**: Built-in environment variables
- **AWS**: Secrets Manager or Parameter Store
- **Docker**: Docker secrets or HashiCorp Vault

---

## Database Migrations

### Development

```bash
# Create migration from schema changes
npx prisma migrate dev --name description

# Apply pending migrations
npx prisma migrate dev
```

### Production

```bash
# Apply migrations without prompts
npx prisma migrate deploy
```

**Important:** Always backup your database before running migrations in production.

---

## Monitoring

### Logging

Next.js logs to stdout by default. In production, consider:

```javascript
// lib/logger.ts
export function log(level: string, message: string, data?: object) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  }));
}
```

### Health Check Endpoint

Add a health check route:

```typescript
// app/api/health/route.ts
import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "healthy" });
  } catch (error) {
    return NextResponse.json(
      { status: "unhealthy", error: "Database connection failed" },
      { status: 503 }
    );
  }
}
```

---

## Backup Strategy

### SQLite Backup

```bash
# Simple file copy
cp prisma/dev.db backups/backup-$(date +%Y%m%d).db

# Or use SQLite backup command
sqlite3 prisma/dev.db ".backup 'backups/backup.db'"
```

### Automated Backup Script

```bash
#!/bin/bash
BACKUP_DIR="/path/to/backups"
DB_PATH="/path/to/prisma/dev.db"
DATE=$(date +%Y%m%d_%H%M%S)

# Create backup
cp $DB_PATH $BACKUP_DIR/backup_$DATE.db

# Keep only last 7 days
find $BACKUP_DIR -name "backup_*.db" -mtime +7 -delete
```

Add to crontab:
```
0 2 * * * /path/to/backup.sh
```

---

## Scaling Considerations

### Current Limitations

1. **SQLite**: Single-writer, file-based
2. **Serverless**: Cold starts on Vercel
3. **Email Rate Limits**: Resend has tier-based limits

### Scaling Path

1. **Database**: Migrate to PostgreSQL for concurrent writes
2. **Email Queue**: Add Redis + Bull for background processing
3. **Caching**: Add Redis for frequently accessed data
4. **CDN**: Use Vercel/Cloudflare for static assets
