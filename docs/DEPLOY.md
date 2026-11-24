# Deploying

The app is static files (`apps/web/dist`). Production runs on **Firebase Hosting**, project `transfer-e2e`,
deployed by GitHub Actions (`.github/workflows/ci.yml`):

| Event                             | Result                                                  |
| --------------------------------- | ------------------------------------------------------- |
| Push to `main` (after all checks) | Live site: https://transfer-e2e.web.app                 |
| Pull request from this repository | Preview channel for 7 days; the URL is posted on the PR |

Only Hosting is used. The app loads no Firebase SDK and no Analytics (docs/SECURITY.md: no third-party scripts).

## One-time setup

1. **Service account.** In the Firebase console: Project settings → Service accounts → _Generate new private key_.
   Alternatively run `npx firebase-tools init hosting:github` once, which creates the account and the secret for you.
   The account needs the _Firebase Hosting Admin_ role (plus _API Keys Viewer_ and _Service Account User_ if
   you create it by hand).
2. **GitHub secret.** Repository → Settings → Secrets and variables → Actions → _New repository secret_:
   name `FIREBASE_SERVICE_ACCOUNT_TRANSFER_E2E`, value = the whole JSON key file. Then delete the local file.
3. **Environment (optional).** The deploy job uses the GitHub environment `production`; add required reviewers
   there if deploys should wait for approval.

## What `firebase.json` sets

- **Security headers:** the same CSP as the `<meta>` tag in the build, plus `frame-ancestors 'none'` (which a meta
  tag can't express); `nosniff`, `no-referrer`, HSTS, COOP; Permissions-Policy allows only the camera (QR scanner).
- **Caching:** hashed files under `/assets/` are immutable for a year. `index.html`, the service worker files and
  the manifest are `no-cache`, so a new release is picked up on the next visit (the service worker then waits
  until all tabs are closed before switching, see ARCHITECTURE.md § Installable app).

## Manual deploy

```sh
pnpm build
npx firebase-tools deploy --only hosting --project transfer-e2e
```

## Other hosts

Any static host works. Serve `apps/web/dist`, copy the headers from `firebase.json`, and set `BASE_PATH` when
building if the app lives under a sub-path.
