# HUFS Town production deployment

## Public entry point

- Web: `https://town.gdgoc.com`
- HUFS SSO callback: `https://town.gdgoc.com/auth/callback`
- Host: Ubuntu 24.04 LTS on ARM64, accessed with `ssh daehyuh-1`
- Application root: `/opt/hufs-town`

Nginx terminates HTTPS and serves ACME HTTP-01 challenges. It proxies `/api/` to the API, `/world/socket` to the World service, and all other paths to the React web container. MariaDB and Redis are private to the Compose network. API, World, and web host ports bind only to loopback.

The SSO callback is served without caching or referrer disclosure. The Nginx access log records the normalized URI without query strings so temporary SSO codes are not written to access logs.

## Public deployment smoke

From the Windows development workspace, run `백엔드/scripts/production-smoke.ps1`. It checks the public home page and expected `GDG HUFS 훕스타운` title, SSO configured status, the published space capacity and media feature, then verifies that the World WebSocket rejects a missing Origin and rejects a trusted Origin without a login session. A title mismatch is reported as a failed smoke check so stale public branding is visible before a release. The script uses no session cookie and does not read or print deployment secrets. A passing smoke check does not prove a full SSO login, authenticated media call, external UDP/ICE reachability, TURN relay, or production capacity.

## Secret handling

The production environment file is `/opt/hufs-town/백엔드/infra/.env.production`, owned by root with mode `0600`. Do not commit it, include it in a source archive, paste its values into logs, or print it with `docker compose config`. It contains the SSO client secret, database credentials, and media control token. The public SSO client ID is `hufs-town`; the callback URI must exactly match the URI registered with the HUFS SSO administrator.

`TOWN_ADMIN_USER_IDS` is an optional comma-separated allowlist of internal account UUIDs for moderation, retention, and analytics consoles. Obtain an approved account UUID from its authenticated `/api/v1/auth/me` response; never grant access by display name or email and do not invent a default administrator. After an operator assigns the UUID, set the variable in the protected `.env.production` and recreate only the API service so Compose reloads that environment:

```bash
sudo docker compose --env-file infra/.env.production -f infra/production.compose.yaml up -d --no-deps --force-recreate --wait --wait-timeout 240 api
```

Confirm API health, then sign in with that account and verify the relevant `/api/v1/reports/access` response and admin UI. Keep the environment file root-owned with mode `0600`; do not print it during editing or validation. If no operator has been assigned yet, leave the allowlist empty.

If configured, the TURN shared secret is injected into Media and the optional Coturn relay; the API and World containers explicitly receive an empty value.

## Web Push notifications

Production VAPID settings belong only in `/opt/hufs-town/백엔드/infra/.env.production`. To initialize them once, run `sudo bash scripts/configure-production-vapid.sh` from the backend directory. The script creates a P-256 key pair on the server, stores URL-safe Base64 keys and the `https://town.gdgoc.com` subject atomically, keeps the environment file `root:root` mode `0600`, and recreates only the API using the current immutable release. It refuses partial configuration and leaves an existing key unchanged. Do not print, copy into source `.env` files, include in archives, or rotate the private key casually: existing browser subscriptions are associated with the configured application key.

An enabled server key lets a signed-in user opt in from the browser notification setting; the user still has to grant browser permission and register that browser. Provider delivery requires a live subscription, so an enabled server configuration alone does not prove that an end-to-end notification reached a device.

## Deploy an update

Create a reviewed source archive from the Windows checkout with:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File C:\Project\hufstown\백엔드\scripts\package-production-source.ps1
```

The script prints a `.tar.gz` path under `C:\Project\hufstown\.build\deployment-source`. It contains only the backend, frontend, root `.dockerignore`, and a manifest of packaged source files; it excludes every `.env*` file, dependency/cache/build output, test report, and log, then validates the archive contents and manifest before publishing it. Transfer the archive and `백엔드/scripts/install-production-source.py` to `/tmp` on `daehyuh-1`, then install it with:

```bash
sudo python3 /tmp/install-production-source.py /tmp/<source-archive>.tar.gz --root /opt/hufs-town
```

The installer writes `.hufs-town-source-files` in the project root. On later updates it removes only files that appeared in the prior managed-source manifest and are absent from the new package. It rejects links, traversal paths, environment files, and cache/build paths; it does not prune directories, unlisted files, persistent volumes, or the production environment. The project-root `.dockerignore` excludes the ownership manifest from image build contexts. The package never contains or replaces `/opt/hufs-town/백엔드/infra/.env.production`.

Deploy the images using a unique release ID. The script builds web, API, World, and Media serially for this two-vCPU host, skips Gradle test tasks in the production image build, preserves immutable service tags, updates the `latest` aliases only after health checks, and restores the previous release if container health or the public SSO/bootstrap smoke check fails. The regular CI workflow remains the place where automated tests run.

```bash
release_id="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)"
sudo bash /opt/hufs-town/백엔드/scripts/deploy-production.sh "$release_id"
```

The first deployment records the currently running image IDs as a legacy rollback point. Later deployments retain the current and previous immutable tags under `/var/lib/hufs-town/release-state`; deployments and rollbacks share a lock. To roll back the application containers to the previous release:

```bash
sudo bash /opt/hufs-town/백엔드/scripts/rollback-production.sh
```

Application rollback does not reverse MariaDB migrations or restore data volumes. Keep schema changes backward-compatible with the previous application release and take a verified backup before any migration that cannot be rolled back safely. The `latest` image aliases remain aligned with the active release for existing Compose maintenance commands. Retained release tags consume disk; the preview-first cleanup command always protects the current/previous releases and every running container image:

```bash
sudo bash /opt/hufs-town/백엔드/scripts/prune-production-releases.sh --keep 2
sudo bash /opt/hufs-town/백엔드/scripts/prune-production-releases.sh --keep 2 --apply
```

Review the first command's candidates and Docker image usage before adding `--apply`. It removes image tags only, never volumes or data.

Check container state without printing environment values:

```bash
sudo docker compose --env-file infra/.env.production -f infra/production.compose.yaml ps
curl -fsS https://town.gdgoc.com/api/v1/auth/config
curl -fsS https://town.gdgoc.com/api/v1/bootstrap
```

Use `sudo docker compose ... logs --tail 100 api world media` when diagnosing startup. Avoid `docker inspect` output that includes container environment variables.

## Network and capacity

The OCI security list or network security group must allow inbound TCP 80 and 443, plus TCP and UDP 44444 for the mediasoup SFU. The host publishes both media transports.

An optional Coturn relay is available through the `turn` Compose profile and stays off in the normal deployment. Before enabling it, confirm the server private VNIC IPv4 address and reserved public IPv4 address, set `TURN_RELAY_IP` and `TURN_EXTERNAL_IP` in the protected production environment file, and set `TURN_REALM` (normally `town.gdgoc.com`). Set `MEDIA_TURN_SHARED_SECRET` to a fresh 64-character-or-longer hexadecimal secret, and configure `MEDIA_ICE_SERVERS_JSON` with both `turn:town.gdgoc.com:3478?transport=udp` and `turn:town.gdgoc.com:3478?transport=tcp` URLs. The same shared secret is used by Media and Coturn; do not print it or include it in an archive.

When intentionally enabling TURN, allow inbound and outbound TCP/UDP 3478 and inbound/outbound UDP 49160–49959 in the OCI security list or network security group and the host firewall. Start the relay before refreshing media:

```bash
sudo docker compose --profile turn --env-file infra/.env.production -f infra/production.compose.yaml up -d --wait turn
sudo docker compose --profile turn --env-file infra/.env.production -f infra/production.compose.yaml up -d --wait --wait-timeout 240 media
```

The image supports ARM64. The profile fails closed when its secret or IP addresses are missing or invalid. Normal deployments do not start Coturn, and no production relay or public UDP route is considered verified until ICE/RTP has been tested from an external network.

The deployment advertises a 100-person space capacity, but this 2-vCPU/11-GiB host has not passed a sustained 100-user production load test. Capacity and media quality must be measured before advertising that level as a supported service guarantee.

The World WebSocket sender pool defaults to four workers. `TOWN_WORLD_SEND_THREADS` accepts 2–16 when a controlled comparison justifies a change. Current 100-client evidence comes from an isolated x64 Preview container, not the production ARM64 host, so it does not establish an operationally optimal thread count.

## Optional production metrics

Prometheus can run in the Compose `observability` profile. It scrapes API, World, and Media metrics over the private Compose network, stores a 15-day history in the named `hufstown-production-prometheus` volume, and publishes its UI only on host loopback port `19090`. Media metrics contain aggregate counts only and do not include space or player identifiers. Nginx does not proxy this port, so the dashboard is not public. The profile is opt-in and uses up to 0.2 CPU and 256 MiB RAM.

Start it after uploading this source update:

```bash
cd /opt/hufs-town/백엔드
sudo docker compose --profile observability --env-file infra/.env.production -f infra/production.compose.yaml up -d --wait prometheus
curl -fsS http://127.0.0.1:19090/-/ready
```

To open the dashboard from an administrator workstation, create an SSH tunnel with `ssh -L 19090:127.0.0.1:19090 daehyuh-1`, then visit `http://127.0.0.1:19090/user/hufs-town.html`. Check **Status → Targets** and **Alerts** before relying on the graphs. Stop only the Prometheus container with `sudo docker compose --profile observability --env-file infra/.env.production -f infra/production.compose.yaml stop prometheus`; keep its named volume to retain history. These rules are evaluated locally and do not send email, Slack, or other external notifications. Configure a real alert receiver and test its delivery before treating this as on-call monitoring.

## Backups and certificate renewal

**Current operator decision (2026-09-29): production backups are intentionally not configured.** The service continues without an off-host backup destination. Loss or corruption of the host/database storage can permanently remove account, space, chat, uploaded-asset, and recording data. Do not treat persistent Docker volumes or the local backup scripts as a recovery copy. The encrypted backup procedure below remains available if the operator later chooses a separate destination; no schedule, destination, or private decryption key is installed on the production host.

Persistent volumes are named `hufstown-production-mariadb`, `hufstown-production-redis`, `hufstown-production-assets`, and `hufstown-production-recordings`. A production backup includes an InnoDB consistent MariaDB dump, uploaded assets, and room recordings. It excludes Redis sessions/leases, environment secrets, and Prometheus history. Archives are compressed and encrypted with `age`; the server needs only the public recipient, while the private identity stays in a separate trusted location.

On an administrator workstation, create an age identity and record its public recipient without copying the private identity to the server:

```bash
age-keygen -o /secure/offsite/hufs-town-backup-identity.txt
age-keygen -y /secure/offsite/hufs-town-backup-identity.txt
```

Install `age` on the server, then create `/etc/hufs-town/backup.env` as `root:root` mode `0600` with the public recipient and a protected backup destination. Prefer a separately mounted or remote-backed destination with enough free space; the default is `/var/backups/hufs-town` on the application host.

```text
TOWN_BACKUP_AGE_RECIPIENT=age1<the-public-recipient>
TOWN_BACKUP_ROOT=/mnt/hufs-town-backups
TOWN_BACKUP_REQUIRE_MOUNT=true
```

Run and verify a backup without printing the production environment file or stopping application containers:

```bash
sudo apt-get install -y age python3
sudo bash /opt/hufs-town/백엔드/scripts/backup-production.sh
sudo bash /opt/hufs-town/백엔드/scripts/verify-production-backup.sh /mnt/hufs-town-backups/<backup-directory>
```

When `TOWN_BACKUP_REQUIRE_MOUNT=true`, the backup command fails before contacting Compose if the configured destination is not itself a mounted filesystem; it will not silently create a local fallback directory. `backup-production.sh` writes only encrypted database, asset, and recording archives plus a manifest and SHA-256 checksums. It publishes a completed backup by an atomic directory rename and removes an incomplete temporary backup after failure. `verify-production-backup.sh` checks the expected files and their hashes; it does not prove that the private key can decrypt them. For an isolated restore check, provision the private identity on a trusted recovery host as a root-owned `0600` file, then run:

```bash
sudo bash /opt/hufs-town/백엔드/scripts/restore-production-backup.sh \
  /mnt/hufs-town-backups/<backup-directory> \
  /secure/offsite/hufs-town-backup-identity.txt
```

`restore-production-backup.sh` verifies and decrypts the backup, imports the database into a disposable locally available MariaDB image with no network, image pull, or published ports, and extracts assets/recordings into a new owner-only directory under `/var/tmp/hufs-town-restores` by default. The temporary database is removed after the check; extracted files remain in the printed result directory and contain user content, so restrict access and remove them securely after review. This is a recovery check only: it never replaces production data, volumes, or service routing, and table counts do not establish that the application can read the restored data. Do not point its output at `/`, the application project, the backup directory, or a shared directory.

Retention cleanup is separate and requires an explicit keep count. Preview is the default; only add `--apply` after reviewing the candidates and confirming the retention policy:

```bash
sudo bash /opt/hufs-town/백엔드/scripts/prune-production-backups.sh --root /mnt/hufs-town-backups --keep 14
sudo bash /opt/hufs-town/백엔드/scripts/prune-production-backups.sh --root /mnt/hufs-town-backups --keep 14 --apply
```

The tool takes the same backup lock, verifies every matching backup before deletion, and stops without deleting anything if a candidate is invalid. No automatic retention timer is installed; choose and document the retention count before scheduling `--apply`.

The database dump uses `--single-transaction`; the database and file volumes are copied sequentially and do not form one atomic snapshot. Avoid taking a backup while uploads or recordings are actively changing, or coordinate a storage snapshot/quiesced maintenance window for a consistent recovery point. Redis is intentionally not restored, so users sign in again after recovery. The tools do not configure a schedule, retention deletion, off-host upload, or production promotion/rollback; T26.2 remains incomplete until those are configured and a real recovery rehearsal is recorded under T26.3. Never use `docker volume prune` to manage these backups or production volumes.

The regression test uses mocked Docker/Compose responses, a mocked database importer, synthetic content, and a temporary age identity. It checks archive encryption, hashes, safe extraction, isolated-container flags, cleanup, and output-path protections, but does not run a real MariaDB restore. Run it after changing the tools with `bash /opt/hufs-town/백엔드/scripts/test-production-backup.sh`; it does not contact the production host. The `certbot.timer` systemd timer is enabled; keep `/var/www/certbot` and the port-80 ACME location available for renewal.
