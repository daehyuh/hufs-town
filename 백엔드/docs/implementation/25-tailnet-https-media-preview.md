# Tailnet HTTPS media preview

The existing `-TailnetPreview` mode is intentionally an anonymous, HTTP-only page preview. Browsers do not allow microphone, camera, or screen capture on the Tailscale IP HTTP origin. `-TailnetHttpsPreview` adds a separate preview path for testing the core communication flow from another tailnet device.

Run `scripts/dev.ps1 start -Profile preview -TailnetHttpsPreview`. It uses the host's MagicDNS HTTPS name through Tailscale Serve, a secure cookie, exact-origin API/World checks, same-origin API/WebSocket proxies, and a separate SFU. The SFU control port is loopback-only; its TCP/UDP media port is bound and announced on the host's Tailscale IPv4. The mode uses an anonymous, non-persistent preview profile and does not load HUFS SSO credentials. Separate ports keep the normal 5173 page and existing local SFU from being replaced.

The launcher refuses to replace an existing Tailscale Serve configuration. It stores a fingerprint of the route it creates and removes that route on `scripts/dev.ps1 stop` only if no other process has changed the configuration. The dedicated Media Compose project is stopped during cleanup, and its named recording volume is retained. If Tailscale requires HTTPS activation, the CLI prompt is left visible; the launcher waits for the HTTPS URL to answer before reporting success.

## Validation

- PowerShell parser accepted `scripts/dev.ps1` and `scripts/media.ps1`.
- Docker Compose rendered the isolated Media bindings as `127.0.0.1:18088` for the control API and `100.87.52.42:44446` for TCP and UDP WebRTC; the tailnet IP was read dynamically by the launcher.
- `pnpm build` passed after Vite was updated to read secure preview host/proxy targets from its process environment.
- A local start reached a healthy dedicated Media container and API/World management health `UP` on 18086/18087. The running processes and dedicated Media container were stopped after inspection.
- Tailscale Serve remained unconfigured (`serve get-config --all` contained only the version field), and `https://jjoayong.tail55aac.ts.net/` did not answer. Therefore the HTTPS page, browser capture permissions, and phone RTP were not verified. The previous `5173` listener and `44444`–`44445` media listeners remained untouched.

The remaining acceptance check is to enable/approve HTTPS for the tailnet if requested, start the command above in an interactive terminal, open the printed `https://…ts.net/` URL on a Tailscale-connected phone, join as a guest, and verify nearby chat, microphone, camera, and screen sharing through RTP. This is a private preview and does not validate real SSO or production TURN.
