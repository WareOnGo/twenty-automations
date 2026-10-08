# Deployment & CI/CD

This service runs on a single AWS EC2 instance in `ap-south-1`. GitHub Actions auto-deploys on every push to `main`.

---

## Where things live

### AWS (region: `ap-south-1` / Mumbai)

| Resource | ID / Value | Notes |
|---|---|---|
| EC2 instance | `i-05dd21da0daf7d078` | Name tag: `crm-automations` |
| Instance type | `t4g.micro` | 2 vCPU (Graviton arm64), 1 GB RAM |
| AMI | Amazon Linux 2023 arm64 | `ami-0c64092ef0a77b87f` |
| Root disk | 8 GB gp3 | Deletes on termination |
| Public IP | `13.206.110.74` | **Not static** — changes if the instance is stopped/started |
| Public DNS | `ec2-13-206-110-74.ap-south-1.compute.amazonaws.com` | Also changes on stop/start |
| Security group | `sg-0542cdfabada9b7dc` (`crm-automations-sg`) | Ingress: 22 from home IP, 80 + 443 from anywhere |
| SSH key (AWS-side) | key pair `crm-ec2` (ed25519) | Private key: `~/.ssh/crm-ec2.pem` on your laptop |
| GitHub Actions deploy key | `gha_deploy` (ed25519) | Separate key just for CI — lives as a GitHub secret |

AWS Console links (ap-south-1):
- Instance: https://ap-south-1.console.aws.amazon.com/ec2/home?region=ap-south-1#InstanceDetails:instanceId=i-05dd21da0daf7d078
- Security group: https://ap-south-1.console.aws.amazon.com/ec2/home?region=ap-south-1#SecurityGroup:groupId=sg-0542cdfabada9b7dc

### On the server

| Path | What it is |
|---|---|
| `/home/ec2-user/app` | The deployed git checkout (origin: this repo, branch: `main`) |
| `/home/ec2-user/app/.env` | Real environment variables — **not in git** |
| `/home/ec2-user/app/ecosystem.config.cjs` | pm2 process config |
| `/home/ec2-user/.pm2/logs/crm-automations-*.log` | App stdout + stderr |
| `/etc/caddy/Caddyfile` | Reverse proxy config (`:80` → `127.0.0.1:3000`) |
| `/etc/systemd/system/caddy.service` | Caddy systemd unit |
| `/etc/systemd/system/pm2-ec2-user.service` | pm2 auto-start on boot |

### Runtime stack

- **Node.js 20** (via nvm, symlinked to `/usr/local/bin/node`)
- **pm2** — keeps the Node process alive, restarts on crash, starts on boot
- **Caddy** — listens on :80, reverse-proxies to the Node app on :3000
- The Node app itself is never exposed directly to the internet; the SG only opens 80/443.

---

## How CI/CD works

The workflow is defined in `.github/workflows/deploy.yml`.

### Trigger

- Every push to `main`
- Or manually from the Actions tab → "Deploy to EC2" → Run workflow

### What it does

1. Checks out the repo (for reference — we don't actually build anything in CI right now)
2. Writes the `EC2_SSH_KEY` secret to a file, adds the EC2 host to `known_hosts`
3. SSHes into the instance as `ec2-user` and runs:
   - `git fetch --all --prune`
   - `git reset --hard origin/main`
   - Locked dependency install (including the pinned Prisma CLI), with automatic client generation disabled and bounded memory/time
   - Explicit `prisma generate` with the installed CLI; no implicit dependency installs
   - `npm test` and the idempotent, CRM-only `npm run sync:migrate`
   - `pm2 reload crm-automations --update-env` (or `pm2 start` if first run)
   - `pm2 save`
4. Hits `http://<EC2_HOST>/health` up to 5 times; fails the workflow if we never get a 200

### Required GitHub secrets

Set at: **Repo → Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
|---|---|
| `EC2_HOST` | `13.206.110.74` (the current public IP) |
| `EC2_USER` | `ec2-user` |
| `EC2_SSH_KEY` | Full contents of the deploy private key, including the `-----BEGIN ... -----` / `-----END ...-----` lines |

> **Don't put `.pem` contents from `~/.ssh/crm-ec2.pem` in here.** Use the dedicated deploy key (`~/.ssh/gha_deploy`). If you lose it, generate a new one and repeat the "rotating the deploy key" procedure below.

### Watching a deploy

- Actions tab in GitHub → click the most recent run
- Each step shows logs in real time
- If the `Deploy` step fails, the remote `git pull` / `npm ci` / `pm2` output is right there
- If only the `Health check` step fails, the deploy happened but the app is crashing — SSH in and check `pm2 logs`

---

## Common tasks

### SSH into the server

```bash
ssh -i ~/.ssh/crm-ec2.pem ec2-user@13.206.110.74
```

### Tail the app logs

```bash
# From your laptop, one-liner:
ssh -i ~/.ssh/crm-ec2.pem ec2-user@13.206.110.74 'pm2 logs crm-automations --lines 100'

# Or on the box:
pm2 logs crm-automations
pm2 logs crm-automations --err     # errors only
```

### Check app status

```bash
ssh -i ~/.ssh/crm-ec2.pem ec2-user@13.206.110.74 'pm2 ls'
```

### Manual restart (without a deploy)

```bash
ssh -i ~/.ssh/crm-ec2.pem ec2-user@13.206.110.74 'pm2 restart crm-automations'
```

### Manually deploy a specific branch (bypass CI)

```bash
ssh -i ~/.ssh/crm-ec2.pem ec2-user@13.206.110.74 '
  cd ~/app &&
  git fetch --all &&
  git checkout some-other-branch &&
  npm ci --omit=dev &&
  npx prisma generate &&
  pm2 reload crm-automations --update-env
'
```

### Update the `.env` on the server

The `.env` file is **not in git** and CI/CD does not touch it. Update it by scp'ing from your laptop:

```bash
# From your laptop
scp -i ~/.ssh/crm-ec2.pem ./.env ec2-user@13.206.110.74:/home/ec2-user/app/.env
ssh -i ~/.ssh/crm-ec2.pem ec2-user@13.206.110.74 '
  chmod 600 /home/ec2-user/app/.env &&
  pm2 reload crm-automations --update-env
'
```

The `--update-env` flag is important — without it, pm2 keeps the old env vars cached.

### Rotate / update GitHub secrets

- **Repo** → Settings → Secrets and variables → Actions → click the secret → **Update**
- Changes take effect on the **next** workflow run

### Rotate the deploy key (if it leaks)

```bash
# 1. Generate a new key on your laptop
ssh-keygen -t ed25519 -f ~/.ssh/gha_deploy_new -N "" -C "github-actions-crm-deploy"

# 2. Add the new pubkey to EC2, remove the old one
ssh -i ~/.ssh/crm-ec2.pem ec2-user@13.206.110.74

# On the server, edit ~/.ssh/authorized_keys:
#  - remove the line ending with "github-actions-crm-deploy"
#  - add the new pubkey (contents of ~/.ssh/gha_deploy_new.pub)

# 3. In GitHub, update the EC2_SSH_KEY secret with the contents of gha_deploy_new
# 4. Trigger the workflow manually to confirm it still deploys
# 5. Delete the old key locally: rm ~/.ssh/gha_deploy
```

### Add a new env var / secret

1. Add it to `~/ec2-user/app/.env` on the server (scp or edit in place)
2. `pm2 reload crm-automations --update-env`

CI/CD does **not** manage `.env`. If you want CI to inject secrets, you'd set them as GitHub secrets and have the workflow write them to `.env` on the server — but right now that's not wired up and `.env` is the source of truth on the box.

### Open a new port in the security group

```bash
# Example: allow port 8080 from anywhere
aws ec2 authorize-security-group-ingress \
  --region ap-south-1 \
  --group-id sg-0542cdfabada9b7dc \
  --protocol tcp --port 8080 --cidr 0.0.0.0/0
```

Or via console: EC2 → Security Groups → `crm-automations-sg` → Inbound rules → Edit.

### Update the SSH ingress when your home IP changes

```bash
# Remove the old rule (check current rule first)
aws ec2 describe-security-groups --region ap-south-1 --group-ids sg-0542cdfabada9b7dc \
  --query "SecurityGroups[0].IpPermissions[?FromPort==\`22\`]"

# Revoke the stale IP
aws ec2 revoke-security-group-ingress \
  --region ap-south-1 \
  --group-id sg-0542cdfabada9b7dc \
  --protocol tcp --port 22 --cidr OLD_IP/32

# Add your new IP
MY_IP=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress \
  --region ap-south-1 \
  --group-id sg-0542cdfabada9b7dc \
  --protocol tcp --port 22 --cidr "$MY_IP/32"
```

### Stop / start / terminate the instance

```bash
# Stop (you stop paying for compute; EBS + public IPv4 still cost a bit)
aws ec2 stop-instances --region ap-south-1 --instance-ids i-05dd21da0daf7d078

# Start (gets a NEW public IP — update EC2_HOST secret!)
aws ec2 start-instances --region ap-south-1 --instance-ids i-05dd21da0daf7d078

# Terminate — permanently deletes the instance and its root volume
aws ec2 terminate-instances --region ap-south-1 --instance-ids i-05dd21da0daf7d078
```

> **Important:** after a stop+start cycle, the public IP changes. You must update:
> - The `EC2_HOST` secret in GitHub
> - Your local `~/.ssh/known_hosts` entry (`ssh-keygen -R OLD_IP`)

If you don't want this fragility, allocate an Elastic IP — it costs the same as the auto-assigned public IP (~$3.6/mo in ap-south-1) but survives stop/start.

---

## Troubleshooting

### CI run: `Permission denied (publickey)` in the Deploy step

- The `EC2_SSH_KEY` secret is wrong or was truncated when pasted. Re-paste the full key including the BEGIN/END lines.
- Or the deploy pubkey was removed from `~/.ssh/authorized_keys` on the server.

### CI run: `Host key verification failed`

- Something changed on the server side (e.g. instance was recreated). The workflow runs `ssh-keyscan` fresh each time so this usually shouldn't happen, but if it does, stopping and restarting the instance is the usual cause.

### CI run: Deploy step succeeds but Health check fails

- App is crash-looping. SSH in and check `pm2 logs crm-automations --err --lines 100`.
- Most common: bad `.env` value, DB connection failure, missing table after a schema change.

### `502 Bad Gateway` when hitting the public IP

- Caddy is up but the Node app on :3000 is down. SSH in, run `pm2 ls`, check `pm2 logs`.

### App is slow / OOM

- `t4g.micro` only has 1 GB RAM. Check `free -m` and `pm2 monit`.
- `ecosystem.config.cjs` sets `max_memory_restart: "400M"` — if the app is restarting every few minutes, that's why.
- Bump to `t4g.small` (2 GB) if sustained: modify the instance type in AWS Console or via CLI after a stop.

### Lost the `~/.ssh/crm-ec2.pem`

- You cannot recover it — AWS only shows it once at key creation.
- Options:
  1. Use the GitHub Actions deploy key (`~/.ssh/gha_deploy`) to SSH in, then add a new personal pubkey to `authorized_keys`.
  2. If both keys are lost: detach the root volume, attach it to a rescue instance, add a new pubkey, reattach. Painful — don't lose both.

---

## Architecture diagram (text)

```
Internet
   │
   │  :80
   ▼
┌────────────────────────────────────────────┐
│ EC2 t4g.micro (13.206.110.74)              │
│                                             │
│   ┌──────────────┐        ┌──────────────┐ │
│   │ Caddy :80    │───────▶│ Node :3000   │ │
│   │ (reverse     │  HTTP  │ (Express +   │ │
│   │  proxy)      │        │  Prisma)     │ │
│   └──────────────┘        └──────┬───────┘ │
│                                  │         │
│                                  │ Prisma  │
└──────────────────────────────────┼─────────┘
                                   │
                                   ▼
                         External Postgres
                      (Supabase / Neon / etc.)

GitHub push to main
   │
   ▼
GitHub Actions ── SSH ──▶ EC2 (git pull + pm2 reload)
```

---

## File references

- CI/CD workflow: `.github/workflows/deploy.yml`
- pm2 config (on server only): `/home/ec2-user/app/ecosystem.config.cjs`
- Caddy config (on server only): `/etc/caddy/Caddyfile`


## Prisma postinstall recovery

The October 8 deployment fetched its commit successfully, then stalled inside
`@prisma/client` postinstall. After instance recovery, startup failed because the
client was uninitialized. The workflow now skips implicit generation with
`PRISMA_SKIP_POSTINSTALL_GENERATE=1`, installs the lockfile's CLI explicitly, and
runs generation separately with `PRISMA_GENERATE_SKIP_AUTOINSTALL=1`. npm and
Prisma commands have a 256 MB Node heap limit and 180/90-second timeouts; the
application's runtime heap settings are unchanged. SSH keepalives retain progress
through quiet installation phases. Do not infer an OOM kill solely from a broken
SSH pipe; inspect npm and kernel logs first.
