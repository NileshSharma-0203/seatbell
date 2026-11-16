# Taking Seatbell to production

Do these in order. Step 1 decides whether the current data source can be used at all, so finish it before spending money.

Budget about one evening, plus up to a day of waiting on DNS.

## 0. Get it building on your laptop

The project was built somewhere that couldn't download packages, so these haven't run yet: `npm install`, the real `pg` driver, and `docker build`.

```sh
npm install                # creates package-lock.json, which Docker and CI need
createdb seatbell_test
TEST_DATABASE_URL=postgres://localhost/seatbell_test npm test
npm run typecheck
docker build -t seatbell:local .
```

If a test fails only here, it's most likely a difference with the real `pg` driver. Fix it now, while it's cheap.

Create a **public** GitHub repo called `seatbell`. Recruiters can then read it. Commit everything, including `package-lock.json`, but don't push to `main` until step 7, because a push triggers a deploy.

## 1. Check the data source (go or no-go)

The code calls the same class search API that the public class search page uses. The URL and the bearer placeholder come from public GitHub projects, but **the live response shape hasn't been verified**, and sources disagree on whether login is required.

1. Open a **private window, not signed in to ASU**, and go to <https://catalog.apps.asu.edu/catalog/classes>.
2. Open DevTools, then the Network tab, and search for a course.
3. Find the `search/classes` request. Note the `term=` value, and the `Authorization` request header.

| What you see while logged out | What to do |
| --- | --- |
| Results load, with a fixed placeholder header such as `Bearer null` | Continue. Put that exact value in `ASU_AUTHORIZATION`. |
| Results need you to sign in, or the token is tied to your session | **Stop.** Never paste a token from your own login into this app. Go to step 2 and ask for access first. |

Then run one request:

```sh
ASU_AUTHORIZATION='Bearer null' npm run probe -- CSE 310 2271
```

Compare the printed seats with the website. If it reports an unreadable record, the output lists the real field names. Add them to the `firstOf` lists in `src/asu/parse.ts`, trim a couple of records from `test/fixtures/live-sample.json` into `test/fixtures/class-search.json`, and rerun the tests. Also check that `days`, `start`, and `end` filled in. Without them the overlap warnings stay off, but alerts still work.

Spring 2027's term code, `2271`, is inferred from the pattern in Fall 2026's `2267`. Use whichever value the site actually sends.

## 2. Reduce the policy risk

You are an ASU student, so this is your risk to manage. [ACD 125](https://provost.asu.edu/sites/default/files/page/2541/ogc-acd125-2017.pdf) and the [ASU terms of use](https://www.asu.edu/tou/) prohibit using ASU data or resources without authorization, interfering with services, and unauthorized use of ASU marks. Neither mentions polling tools specifically, so how they apply is up to ASU. I'm not a lawyer, and this isn't legal advice.

- Send the note in `docs/LAUNCH.md` before you launch publicly. Written permission is also a great interview story.
- Run it from your own server, never ASU machines or networks.
- Keep the defaults: 2 seconds or more between requests, and the circuit breaker on.
- Keep it free, because the policy also restricts commercial use.
- Don't put "ASU," "Sun Devil," or Sparky in the name, domain, or logo.
- If ASU asks you to stop, set `POLLING_ENABLED=false` that day.

## 3. Domain

The [GitHub Student Developer Pack](https://education.github.com/pack) lists one free domain from Name.com, including `.app` and `.dev`, and a free `.tech` domain for a year. I couldn't check whether `seatbell` is available from here. If you pick another name, change `APP_NAME` and `public/manifest.webmanifest`.

## 4. Server

Use any Ubuntu 24.04 VPS with at least 2 GB of RAM. The Student Pack lists $100 of Azure credit, and a small VPS elsewhere is usually a few dollars a month.

Why not serverless Postgres? The poller writes every few seconds, so scale-to-zero never kicks in. A single box is simpler, and running it yourself is what you want to talk about.

```sh
ssh root@SERVER
curl -fsSL https://get.docker.com | sh
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
mkdir -p /opt/seatbell && chown deploy /opt/seatbell
mkdir -p /home/deploy/.ssh && cp ~/.ssh/authorized_keys /home/deploy/.ssh/ && chown -R deploy /home/deploy/.ssh
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw allow 443/udp && ufw --force enable
```

Note that Docker's published ports bypass `ufw`. Grafana is bound to `127.0.0.1` for that reason, and nothing else publishes a port except Caddy.

## 5. DNS and email

1. At your registrar, add `A` records for `@` and `www` pointing to the server.
2. Create a [Resend](https://resend.com/pricing) account and add the domain. Add the DNS records it gives you (SPF and DKIM), and wait for it to show verified.
3. The free plan allows 3,000 emails a month and **100 a day**. `EMAIL_ALERT_DAILY_BUDGET=80` stops alerts from using the quota that sign-in codes need. If `npm run stats` shows failed alerts, encourage push or upgrade.

## 6. Secrets

On your laptop, run `npm run vapid` and save the output. On the server:

```sh
sudo -iu deploy
cd /opt/seatbell
nano .env        # paste from .env.example and fill everything in
chmod 600 .env
```

Use `openssl rand -hex 32` for each secret. Keep the VAPID keys the same forever, because changing them breaks every existing push subscription.

## 7. Connect CI/CD and deploy

Make a dedicated deploy key:

```sh
ssh-keygen -t ed25519 -f seatbell_deploy -N ""
ssh-copy-id -i seatbell_deploy.pub deploy@SERVER
ssh-keyscan SERVER > known_hosts
```

In GitHub, go to Settings, then Environments, create `production`, and add these secrets:

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | Server IP or hostname |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | Contents of `seatbell_deploy` |
| `DEPLOY_KNOWN_HOSTS` | Contents of `known_hosts` |

Push to `main`. The workflow tests, builds an image, migrates, starts the new version, and rolls back automatically if health checks fail.

## 8. Test the real thing

- [ ] `https://your-domain/readyz` says `ready`, and the padlock is valid.
- [ ] Sign in with your ASU email. Check the code didn't land in spam.
- [ ] Look up a real course. Seats match the ASU site.
- [ ] Turn on push on your phone. On iPhone, add to Home Screen first.
- [ ] Send a test alert and confirm both email and push arrive.
- [ ] Watch a section that currently has open seats, then force a real alert:

```sh
docker compose exec db psql -U seatbell -c "UPDATE sections SET open_seats = 0 WHERE class_nbr = 'THE_CLASS_NUMBER';"
```

The next real check sees it go from 0 to open and sends through the whole pipeline.

## 9. Monitoring

External uptime is the number that goes on your resume, because a monitor on the same server dies with it.

1. In [UptimeRobot](https://uptimerobot.com), create two HTTP monitors at the free 5-minute interval: `https://your-domain/readyz` and `https://your-domain/healthz/poller`. The second goes red if nothing has been checked for 10 minutes.
2. Turn on email or phone alerts for yourself, and publish its status page.
3. For Grafana, run `ssh -L 3001:localhost:3001 deploy@SERVER` and open <http://localhost:3001>. Sign in as `admin` with `GRAFANA_PASSWORD`. The Seatbell dashboard is already set up.

## 10. Backups

A nightly dump lands in `/opt/seatbell/backups`, but that's the same disk. Copy it elsewhere regularly, and **do one restore drill now**:

```sh
docker compose exec -T db createdb -U seatbell restore_test
gunzip -c backups/LATEST.sql.gz | docker compose exec -T db psql -q -U seatbell restore_test
docker compose exec db psql -U seatbell restore_test -c 'select count(*) from users'
docker compose exec db dropdb -U seatbell restore_test
```

## Running it day to day

```sh
cd /opt/seatbell
docker compose logs -f --tail 100 worker
docker compose exec web node src/stats.ts
docker compose exec db psql -U seatbell -c 'select kind, message, created_at from feedback order by id desc limit 20'
sed -i 's/^POLLING_ENABLED=.*/POLLING_ENABLED=false/' .env && docker compose up -d worker      # kill switch
sh ops/deploy.sh "$(cat .previous-image)"                                                       # roll back
```

**Each term:** add the new term to `TERMS`, for example `TERMS=2271:Spring 2027,2274:Summer 2027`, and restart. Confirm the code in the site's URL first.

**Migrations** run before the new code starts and aren't reversed, so a change must keep working with the previous release. Add a column in one deploy, and remove the old one in a later deploy.
