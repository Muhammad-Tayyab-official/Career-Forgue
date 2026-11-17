# CareerForge

CareerForge is a local-first job-application workspace. The server is a small
Node.js HTTP application backed by SQLite, with support for account sessions,
workspace state, résumé imports, and opportunity extraction.

## Requirements

- Node.js 24 or newer
- Python 3 with `pypdf` for PDF résumé imports

Install the optional PDF dependency with:

```bash
python -m pip install pypdf
```

## Run locally

Start the server from the repository root:

```bash
node server.mjs
```

Then open <http://127.0.0.1:4310>.

The server listens on loopback only. User accounts and workspace data are
stored in `data/careerforge.sqlite`, which is created automatically when the
server starts. Set `PORT` to use another local port:

```bash
PORT=4400 node server.mjs
```

To use a different SQLite file, set `CAREERFORGE_DB`:

```bash
CAREERFORGE_DB=/path/to/careerforge.sqlite node server.mjs
```

## Local data and security

- The local server is intended for development and personal use.
- Account passwords are stored as derived hashes; session cookies are
  HTTP-only and same-site.
- Export or delete workspace data from the application before removing the
  database file.
- Do not expose the server directly to the public internet.

## Current repository status

This checkout contains the server runner and its README. The server expects
the compiled frontend in `dist/` and the résumé/opportunity helper modules
referenced by `server.mjs`; those files must be present before the application
can be started successfully.

The server exposes endpoints under `/api/v1/` for authentication, workspace
state, résumé import, and opportunity extraction. Keep the frontend and helper
modules in sync with those routes when completing the application.
