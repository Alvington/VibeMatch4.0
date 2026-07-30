# Deploying VibeMatch to Render (permanent link)

This repo is now production-ready: Postgres instead of SQLite, a health check
endpoint, graceful shutdown, and a `render.yaml` Blueprint that provisions the
web service + database together in one step.

## 1. Push this code to GitHub

```bash
cd VibeMatch3.0-main
git init                                   # skip if already a git repo
git add .
git commit -m "Production-ready: Postgres, health check, Render blueprint"
git branch -M main
git remote add origin https://github.com/<your-username>/vibematch.git
git push -u origin main
```

(Create the empty repo on GitHub first if you haven't: github.com/new)

## 2. Deploy via Render Blueprint

1. Go to https://dashboard.render.com → **New +** → **Blueprint**
2. Connect your GitHub account if you haven't, then select the `vibematch` repo
3. Render reads `render.yaml` automatically and shows you a plan: one **Web
   Service** (`vibematch`) + one **Postgres** database (`vibematch-db`)
4. You'll be prompted for the two secret env vars (marked `sync: false` so
   they're never committed to git):
   - `AT_API_KEY` — your real Africa's Talking API key
   - `AT_USERNAME` — your Africa's Talking username (not `sandbox`, since
     you're using live credentials)
5. Click **Apply**. Render will:
   - provision the Postgres database
   - run `npm install` (which also runs `prisma generate` via `postinstall`)
   - run `npx prisma migrate deploy` (creates all tables) before starting
   - start the app with `npm start`
6. When the deploy finishes, your permanent URL is
   `https://vibematch.onrender.com` (or whatever subdomain Render assigns —
   check the dashboard). Every future `git push` to `main` auto-redeploys.

## 3. Verify it's actually live

```bash
curl https://vibematch.onrender.com/healthz
# {"status":"ok"}
```

Then open the URL itself in a browser — you should see the VibeMatch landing
page, and `/login.html` should let you request a real OTP over SMS.

## 4. (Optional) Seed demo data

Render's free plan doesn't include a persistent shell session, so run this
**locally** against the production database instead:

```bash
# Get the "External Database URL" from the vibematch-db page in the Render dashboard
DATABASE_URL="<external connection string from Render>" npm run seed
```

## 5. If `prisma migrate deploy` fails on first deploy

I hand-wrote the initial migration SQL (no network access here to generate it
against a live Postgres instance), so if the build logs show a migration
error, the safe fallback is to swap the migration step in `render.yaml`'s
`buildCommand` from `migrate deploy` to `db push`:

```yaml
buildCommand: npm install && npx prisma db push
```

This pushes your `schema.prisma` directly to the database instead of
replaying the SQL file, and it's self-correcting — Prisma computes the exact
SQL needed by diffing against the live DB rather than trusting a pre-written
script.

Note: on Render's free plan, migrations run as part of `buildCommand` rather
than a separate `preDeployCommand`, since pre-deploy commands require a paid
plan. If you upgrade later, moving `npx prisma migrate deploy` into a real
`preDeployCommand` is cleaner (it runs after build, right before the new
version goes live, rather than during build).

## Things worth knowing about the free plan

- **Web service spins down after 15 minutes of inactivity** and takes
  30–60s to wake back up on the next request. Fine for testing/showing
  people; not great for real users hitting a cold start, and Socket.io chat
  connections will drop during spin-down. Upgrade to the **Starter** plan
  (~$7/mo) in the service settings to keep it always-on.
- **Free Postgres databases expire** (Render currently deletes free DBs after
  a set number of days of the trial period). For a database that stays
  "permanent" indefinitely, upgrade `vibematch-db` to a paid plan
  (**starter**, a few dollars/month) in the Render dashboard before that
  happens.
- **Custom domain**: Settings → Custom Domains on the web service, once you
  want something nicer than `*.onrender.com`.
