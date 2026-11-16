# Seatbell launch plan

Seat alerts are seasonal, so the calendar sets the schedule. Dates are from the [ASU academic calendar](https://registrar.asu.edu/academic-calendar).

| Date | Spring 2027 event | Why it matters |
| --- | --- | --- |
| Already open | Registration opened Oct 19 for in-person students | People are hunting for seats now |
| Jan 11 | Sessions A and C begin | Peak schedule changes |
| Jan 12 | Last day to add a Session A class without college approval | Biggest moment of urgency |
| Jan 17 | Session C add deadline, Session A drop deadline | Drops free up seats |
| Jan 24 | Session C drop deadline | Last burst of the main term |
| Mar 15 to 16 | Session B begins, add deadline | Second, smaller wave |

**Launch this before the Raft store gets your full attention.** Code can be built any time, but missing January means waiting for the next registration wave to get users. Raft can take the time this product spends accumulating them.

## Schedule

| When | Goal | Done when |
| --- | --- | --- |
| Nov 9 to 15 | Finish `docs/DEPLOY.md` steps 0 to 9, and send the ASU note | Your own real alert arrives on your phone |
| Nov 16 to 22 | Private beta with the Hacking Club | 15 to 25 people have a watch, and you've fixed what they hit |
| Nov 23 to Dec 13 | Public launch, then finals break | First Reddit post is up and feedback is answered |
| Jan 3 to 17 | The real launch: post again, ask clubs and advisors | Service stays up under peak |
| Jan 18 on | Write up the numbers, add the bullet | Resume updated with measured figures |

## Where it stands against what exists

ASU students already have options, and users will ask why yours. I found [ASU Class Notifier](https://asu-class-notifier.pages.dev/) (free, web push, usually within a minute), [Pick A Class](https://aryash-dubey.web.app/projects/pick-a-class) (claims 15 seconds), and [Coursicle](https://statepress.com/article/2018/03/spcampus-coursicle-launches-asu-help-students-course-registration).

Don't claim to be the fastest, since at gentle polling rates you won't be. Lead with what you can show:

- **Any-section alerts,** for people who just need the course.
- **Push and email together,** so one missed channel doesn't cost the seat.
- **A public status page,** showing when the last check ran and how many failed.
- **Overlap warnings** between the sections you're watching.

Try each competitor before you post, because I could only read their landing pages. If one already does all of this, ask beta users what's missing and build that. **Reserved seats are the best next feature.** ASU's app calls a `/search/reservedseats` endpoint, and an alert that says whether a seat is actually open to you would solve a real annoyance.

## Asking ASU first

Send this before the public post. Your Hacking Club advisor or a CS professor can tell you who owns the class search service, and an introduction from them will get a better response.

> Subject: Student project using public class search data
>
> Hi, I'm a [year] [major] student and I lead the Hacking Club. I built a free tool that alerts students when a seat opens in a full class. It reads the same public information as the class search page, does not use student logins, and never registers anyone.
>
> To keep the load low, each course is checked once per cycle no matter how many students watch it, with at least two seconds between requests, and it stops automatically if your systems return errors. Its requests identify the project and include my contact information.
>
> Is this acceptable, and is there a preferred way to get this data? I'm happy to change how it works, or to shut it off if you'd rather I didn't run it.
>
> Thank you,
> [Name]

## Posts you can use

Check each community's self-promotion rules first, and say plainly that you built it.

**Hacking Club or group chat**

> I built a free seat alert tool for ASU classes and need people to break it before registration gets busy. Sign in with your ASU email, pick a full class, and it pings you when a seat opens. Would really value bug reports: [link]?ref=club

**r/ASU**

> Title: I made a free tool that alerts you when a full class opens up
>
> I'm a student here and got tired of refreshing class search, so I built this. Pick a section, or any section of a course, and you'll get a push notification or email when a seat opens. Then you register yourself in My ASU.
>
> It's free, there are no paid tiers, and it never asks for your ASU password. It isn't affiliated with ASU. Some open seats are reserved, so check My ASU when you get an alert.
>
> Status page and feedback form are on the site. Tell me what's broken: [link]?ref=reddit

Use a different `?ref=` for each place. `npm run stats` shows signups by source, so you'll know what worked. Other places to try: major and class Discords, CS clubs, advising newsletters, and a State Press pitch, since it has covered tools like this before.

## Support

Reply to every piece of feedback within a day during launch, and make the fix visible. A missed alert is your most serious bug. Check its row in `notifications` and write down what happened.

## Metrics

Run `npm run stats` weekly, and save the output in a spreadsheet so you have history.

| What you measure | Where it comes from |
| --- | --- |
| Real users | "Users with at least one alert," which is stricter than signups |
| Daily and weekly active users | `npm run stats` |
| Notifications sent | "Alerts sent (total)" |
| Uptime | The UptimeRobot report only |
| Alert speed | Median detect-to-send, plus the Grafana latency panel |

Reasonable early targets are 25 beta users, then 100 users with an alert by Jan 17. Those are guesses until you see the first post perform.

## The resume bullet

Fill it in only after launch, using measured numbers:

> Built and deployed Seatbell, a class seat alert service used by **[N]** ASU students; Postgres-backed job queue (`SKIP LOCKED`, leases, retries), Docker, and CI/CD with auto-rollback, delivering **[X]** alerts at **[Y]%** uptime over **[Z]** days.

- N is users with at least one alert, not page visits.
- Y comes from the external monitor, for a stated period. Don't quote uptime from a few days.
- Don't round up, because you'll be asked about it, and "Users are the one thing nobody can fake" only holds if yours are real.

## What to say in interviews

- Why the queue is in Postgres, and what `SKIP LOCKED` does under concurrent claims. This is especially relevant for Neon.
- How one transaction ties seat changes to deliveries, and why delivery is at-least-once with idempotency rather than exactly-once.
- What happens when a worker dies mid-job: leases, reaping, and fencing the zombie.
- How request rate stays fixed as users grow.
- Your real incidents. Keep a short log from day one, because a true outage story beats any feature.
