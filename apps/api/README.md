## API

### Environment Variables

The API requires the following environment variables:

#### Redis Configuration
```bash
# Local development (Docker):
REDIS_URL=redis://localhost:6379

# Production (the Kamal `redis` accessory on the kamal Docker network):
# REDIS_URL=redis://invoicewise-redis:6379
```

#### Local Development Setup

1. **Start Redis with Docker:**
   ```bash
   docker run -d --name redis -p 6379:6379 redis:alpine
   ```

2. **Set environment variable:**
   ```bash
   export REDIS_URL=redis://localhost:6379
   ```

3. **Test Redis connection:**
   ```bash
   bun run packages/cache/src/test-redis.ts
   ```

#### Database Configuration
```bash
DATABASE_PRIMARY_URL=postgresql://...
```

### Development

```bash
bun dev
```

### Production

Production runs as the Kamal `api` role (migrations, then this server and the
workflow runner); see [`docs/deployment.md`](../../docs/deployment.md).

### Cache Implementation

The API uses Redis for distributed caching across multiple server instances:

- **replicationCache**: Tracks recent mutations for read-after-write consistency (10 sec TTL)

Authorization reads are deliberately not cached. Membership, role, API key and
OAuth token checks go to the primary database on every request so that removal,
demotion and revocation take effect on the next call. See
[`docs/permissions.md`](../../docs/permissions.md).

#### Environment-Specific Configuration

The Redis client automatically configures itself based on the environment:

- The resolver picks the address family (IPv4 on the Kamal Docker network);
  IPv6 is forced only on Fly (`FLY_APP_NAME`), whose private network is
  IPv6-only.
- Connection timeout: 15s in production, 5s elsewhere.

This ensures cache consistency across multiple stateful servers and eliminates the "No procedure found" TRPC errors caused by cache misses.
