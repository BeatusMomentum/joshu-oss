# Joshu (open-source box stack)

[![Release](https://img.shields.io/github/v/release/db-aeon/joshu-oss?display_name=release&label=release&color=blue)](https://github.com/db-aeon/joshu-oss/releases/latest)
[![Docker image](https://img.shields.io/github/v/release/db-aeon/joshu-oss?display_name=release&label=ghcr.io%2Fdb--aeon%2Fjoshu--oss&logo=docker&logoColor=white)](https://github.com/db-aeon/joshu-oss/pkgs/container/joshu-oss)

**Canonical AGPL repository** for the Joshu box stack — self-host, build apps, integrate Hermes.

| Repo | Role |
|------|------|
| **joshu-oss** (this repo, public) | AGPL engine + apps — **all community PRs land here** |
| **joshu** (private) | Fleet superset: merges this repo + `proprietary/`, `vendor/`, fleet SOPs |
| **joshu-control-plane** (private) | Portal, provisioning (`hello.joshu.me`) |
| **joshu-design** (private) | Brand pack (JDL) for managed fleet images |

| | |
|--|--|
| **License** | [AGPL-3.0 OR Commercial](LICENSE) — [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md) |
| **Self-host** | [docs/self-host.md](docs/self-host.md) |
| **Contributing** | [CONTRIBUTING.md](CONTRIBUTING.md) — PRs to **this repository** |

Joshu is a local-first app workspace packaged as a Docker image for always-on deployments. Desktop apps include jWeb (HITL browser), jChat, jMail, Connectors, Memory, File Brain, jWhiteboard, Schedules, Welcome, and jMovie.

## Quick start

```bash
git clone https://github.com/db-aeon/joshu-oss.git
cd joshu-oss
npm ci
npm run dev:arozos
```

Self-host on a VPS: [docs/self-host.md](docs/self-host.md) · [Hetzner quickstart](docs/vps-sandbox/hetzner-quickstart.md).

## Documentation

Start at [docs/README.md](docs/README.md).

Key topics: [local installation](docs/local-installation.md) · [executive assistant](docs/executive-assistant.md) · [app SDK](docs/app-sdk.md) · [platform architecture](docs/platform-architecture.md).

## Releases

The current Docker version is shown on the [Releases page](https://github.com/db-aeon/joshu-oss/releases/latest) (and the badge above). Tagging `v*-oss` on this repo builds, pushes to GHCR, and publishes a GitHub Release with image pins plus auto-generated notes (PRs/commits since the previous tag):

- `ghcr.io/db-aeon/joshu-oss:<version>` (+ `:latest`)
- `ghcr.io/db-aeon/joshu-oss-voice-realtime:<version>` (+ `:latest`)

Vanilla theme on the main image. Pins live in [`deploy/RELEASE.json`](deploy/RELEASE.json).

Managed fleet images (`joshu-sandbox`) are built from the private fleet repo after merging OSS `main`.
