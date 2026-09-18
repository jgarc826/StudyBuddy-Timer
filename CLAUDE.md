# StudyBuddy (working title): project brief

This file is the brief for the whole project. Read it fully at the start of every session.

## What we're building

A study-timer web app.

- A visitor presses Start and a 50-minute focus countdown runs, followed by a 10-minute break. The cycle can repeat.
- Every completed focus block is saved as a study session.
- The page shows total hours studied and a GitHub-style contribution grid: one square per day, darker for more minutes studied.
- Later phases (do not build yet): accounts, then friends who can see each other's grids and who is studying right now.

## Who you're working with

I'm a student who knows C++ well. I'm new to JavaScript, HTML/CSS, web development, and AWS. This project has two goals: a deployed project for my resume (I'm applying to software engineering internships), and a codebase I can study afterward until I can explain every part of it in an interview.

That second goal changes how you should work:

- Prefer simple, readable code over clever or compact code. No frameworks, no build tools, and no libraries unless I approve them.
- Comment code for a C++ programmer who has never seen JavaScript or AWS. Explain anything that would surprise me (async/await, closures, event listeners, JSON, HTTP status codes), using C++ comparisons where they help.
- When something breaks, explain the cause in plain language before you fix it.
- Keep NOTES.md up to date (see "Working agreement").

## Architecture (phase 1)

```
Browser -> CloudFront -> private S3 bucket      (static site: HTML, CSS, JS)
Browser -> API Gateway (HTTP API) -> Lambda (Node.js) -> DynamoDB
```

- **Frontend:** plain HTML, CSS, and JavaScript in `site/`. No framework, no bundler, no npm.
- **Hosting:** private S3 bucket behind CloudFront using Origin Access Control. The bucket must never be public. Use the default `*.cloudfront.net` domain. No custom domain and no Route 53 for now.
- **API:** API Gateway HTTP API (not the older REST API type). CORS allows only the CloudFront origin plus `http://localhost` origins for local development. Set conservative throttling on the stage so a bug or a stranger can't burn through my credits.
- **Compute:** one Lambda function on the newest Node.js LTS runtime that Lambda currently supports (check, don't assume). Use the AWS SDK v3 that ships with the runtime, so the function needs no bundled dependencies.
- **Data:** one DynamoDB table, on-demand billing.
- **Infrastructure as code:** Terraform in `infra/`. Every AWS resource is defined there. Nothing is created by hand in the console.
- **Region:** `us-east-1` for everything, which avoids multi-region complications if I add a custom domain later.

### Identity in phase 1 (no login)

On first visit the page generates an ID with `crypto.randomUUID()`, stores it in `localStorage`, and sends it on every API call in an `X-User-Id` header. The backend treats that ID as the user.

This is deliberately simple. Note its limits in the README: history is tied to one browser, and anyone holding the ID can read or write that history. Phase 2 replaces it with Cognito.

### Data model

Single table, designed so accounts and friends fit later without a migration:

- Partition key `PK` = `USER#<userId>`
- Sort key `SK` = `SESSION#<localDate>#<sessionId>`
- Attributes: `startedAt` (ISO 8601 UTC), `minutes` (integer), `localDate` (`YYYY-MM-DD` in the user's own timezone, computed in the browser so the grid matches the user's calendar day)

Putting the date at the front of the sort key lets the API fetch a date range with a key condition instead of reading every item and filtering.

### API

- `POST /sessions` with body `{ sessionId, startedAt, minutes, localDate }`. The browser generates `sessionId` (a UUID). Write with a condition that the item doesn't already exist, so a retried request can't double count. Return 201 on create and 200 if it already existed.
- `GET /sessions?from=YYYY-MM-DD` returns that user's sessions from that date on. The browser computes totals and draws the grid.
- Validate everything on the server: `minutes` is an integer from 1 to 180, dates parse, the user ID and session ID look like UUIDs, and the body is small. Reject anything else with a 400 and a clear message. Never trust the browser.

## Hard constraints

These protect my AWS account. If any task seems to require breaking one, stop and ask me.

1. My account is on the AWS **free account plan**. It can't be billed, and it runs on a fixed pool of credits.
2. Never create or join an AWS Organization, and never set up IAM Identity Center or Control Tower. Doing so converts the account to a paid plan and cancels my credits.
3. If a service or feature says it needs a plan upgrade, stop and tell me. Don't work around it.
4. Serverless only. No EC2, RDS, NAT gateways, load balancers, or anything else that bills by the hour.
5. Set CloudWatch log retention (14 days) on every log group you create.
6. Never write credentials, access keys, or secrets into any file, and never commit them. I authenticate locally with `aws login` (short-lived credentials). If Terraform can't read those credentials, tell me and propose the documented workaround rather than creating long-lived access keys. GitHub Actions authenticates through an OIDC role, never stored keys.
7. IAM is least privilege. Each role gets only the specific actions on the specific resources it needs. No `*` actions or resources unless AWS gives no alternative, and if so, say why in NOTES.md.
8. Before any command that changes something in AWS (`terraform apply`, `aws s3 sync`, and so on), show me what will change and explain it in plain words. Never pass `-auto-approve` on my machine. Never run `terraform destroy` unless I ask for it.

## Stages

Build one stage at a time. Each stage ends with something that works. Do not start the next stage until I say so.

### Stage 1: the timer, on my computer only (no AWS)

- `site/index.html`, `site/style.css`, `site/app.js`
- Start, pause, and reset. 50-minute focus, then 10-minute break, switching automatically, with a clear visual difference between the two.
- Keep the countdown accurate when the tab is in the background: compute remaining time from a stored end timestamp instead of counting ticks.
- A completed focus block is saved as a session. For this stage, save to `localStorage` behind a small storage module (`saveSession`, `loadSessions`) so Stage 3 can swap in the API without touching the rest of the code.
- Show total hours studied and the contribution grid for the last 26 weeks.
- Add a test mode (`?fast=1`) that turns minutes into seconds, so I can test without waiting 50 minutes.
- **Done when:** I can open `index.html` in a browser, finish a fast session, and see the total and the grid update, with no console errors.

### Stage 2: put it on the internet

- Terraform for the private S3 bucket, the CloudFront distribution with Origin Access Control, and an output for the site URL.
- A small deploy script in `scripts/` that syncs `site/` to the bucket and invalidates the CloudFront cache.
- **Done when:** the site loads over HTTPS at the CloudFront URL, and requesting a file straight from the S3 bucket URL is denied.

### Stage 3: the backend

- Terraform for the DynamoDB table, the Lambda function and its role, the HTTP API, CORS, and throttling.
- Lambda code in `backend/`, with the request handling split from the DynamoDB calls so the logic can be unit tested without AWS.
- Unit tests using Node's built-in test runner (`node --test`): validation, the duplicate-session case, and the date filter.
- Swap the frontend storage module from `localStorage` to the API. The user ID stays in `localStorage`.
- **Done when:** finishing a session creates an item in DynamoDB, the grid is drawn from API data, sending the same session twice stores it once, and all tests pass.

### Stage 4: automation and operations

- Move Terraform state to an S3 backend so CI can use it. Prefer the backend's built-in lockfile locking if my Terraform version supports it. Keep the state bucket in a separate small bootstrap configuration so destroying the app doesn't destroy its own state.
- GitHub Actions: on pull requests, run tests plus `terraform fmt -check`, `validate`, and `plan`. On push to `main`, run tests, `terraform apply`, and the site deploy. Authenticate with an OIDC role scoped to this repository.
- A CloudWatch alarm on Lambda errors that emails me through SNS, plus a small dashboard (invocations, errors, duration, API 4xx and 5xx).
- `README.md`: what the app is, an architecture diagram (Mermaid), the design decisions and their trade-offs, how to run and deploy it, what it costs, known limits, and an honest section on how AI tools were used and how their output was verified.
- **Done when:** a push to `main` deploys everything with no manual step, a deliberately broken Lambda triggers the alarm email, and running `terraform destroy` then `terraform apply` rebuilds the whole system. Warn me first that destroy deletes the stored sessions.

### Later (do not build yet)

- Phase 2: accounts with Amazon Cognito. Sessions move from the anonymous ID to the account.
- Phase 3: friends. Friend requests, viewing a friend's grid, and a "studying now" indicator.

## Working agreement

- At the start of a stage, propose a short plan and wait for my approval before writing code.
- Work in small steps. After each working step, suggest a commit with a clear message. The git history should read like a tour of how the project was built.
- Keep `NOTES.md` current as you go. For each step, record in plain language: what you created, why it's needed, what each new file does, and any term I might not know. End each stage's section with five questions an interviewer could ask about what was just built, with short answers.
- Create a `.gitignore` early (Terraform state and `.terraform/`, `node_modules/`, `.env`, OS and editor files).
- At the end of a stage, summarize what now exists, how I can verify it myself, and what the next stage will add. Then stop.

## Repository layout

```
studybuddy/
├── CLAUDE.md
├── NOTES.md
├── README.md
├── site/                index.html, style.css, app.js
├── backend/             Lambda handler, data access module, tests
├── infra/               Terraform
├── scripts/             deploy script
└── .github/workflows/   CI/CD pipelines
```

## Prerequisites (my job, but check them for me)

At the start of the first session, check which of these are installed and tell me what's missing and how to install it on my operating system:

- git, and a GitHub repository for this project
- Node.js (current LTS)
- AWS CLI v2, signed in with `aws login` (not needed until Stage 2)
- Terraform (not needed until Stage 2)
