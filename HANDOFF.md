# Noah Connect — Handoff

_Last updated: 2026-06-28_

## What this product is
Noah Connect is a **daily communication hub** for a small sales/services team —
internal + external comms, plus manager mass-blasts. It is **not** a generic SaaS
dashboard. The differentiators:
- A **Virtual Office** (spatial, ro.am-style floor map) showing live presence —
  who's here, who's on a call, what they're working on.
- **One hub for every channel**: Slack, Gmail, RingCentral (phone/SMS/video via
  WebRTC), SMS (SlickText), internal chat.
- **AI that works while you're away** and catches you up with one-click actions
  (the core "wow" / sales-psychology hook).

Design language: **black + glassmorphism + red (#e54040) accent.** Reference
product the user wants it to feel like: **ro.am (Roam)** — a top-down virtual HQ.

## ⚠️ The single most important lesson from this session
**Stop hand-writing CSS. Use a prebuilt professional component system.**
The user repeatedly said pro components/templates already exist (aura.build,
21st.dev) and was (rightly) frustrated that hand-rolled styling looks like a
prototype. The agreed pivot: rebuild on a real component library.

Tools available in this environment for that (use them):
- **Lovable** (MCP `da5f920c…`) — generates a real React + Tailwind + **shadcn/ui**
  app, live preview, deployable. Best path if Noah Connect becomes the real product.
  `create_project(initial_message, workspace_id?)` → `render_project_widget`.
- **Magic Patterns** (MCP `f3b23969…`) — fast, polished UI/screen generation.
- **Figma** (MCP `4091b4e5…`) — design-first, design system, code export.
- **Replit / Webflow / Canva** also wired in.

The user was about to pick a tool when they asked for this handoff. **Recommended:
Lovable** (real components, real product). Confirm the choice, then drive it from
the module brief below. NOTE: these run under the user's account and consume their
credits — confirm before creating projects.

## Current repo state
- **Stack today:** Node/Express + a **single-file SPA** at `public/index.html`
  (~6900 lines: all HTML/CSS/JS). Deployed on Vercel (auto-deploy on `main`).
- **Working branch:** `claude/session-overview-549p6w`.
- **PRs:**
  - #5, #6, #7 — merged (CSS polish, then the real **Roam-style spatial Office**
    rebuild + an init-listener null-safety fix).
  - **#8 — open (draft).** Contains: animal-photo avatars, "While you were away"
    AI catch-up modal, sticky AI call widget, and the **shell prototype**.
- **Shell prototype:** `public/shell-preview.html` — standalone page (open at
  `/shell-preview.html`). Top channel bar with real provider logos + ← → arrows,
  and **each channel renders as its real surface** (this was a key correction):
  - Office = spatial map (home) · Slack = chat · Gmail = inbox+reader ·
    RingCentral = **phone** (dialpad, voicemail+transcript, dial bar) · Text = SMS.
  This prototype is the **blueprint** for the real rebuild.

## What each module must be (don't flatten them!)
A hard-won correction this session: **every channel is its native modality.**
- **Office** — top-down floor map; people = profile-photo "heads" in rooms;
  presence rings, on-call pulse, 3D-chat bubbles; click head → contact actions.
- **Slack** — channel list + threaded chat + message composer.
- **Gmail** — inbox list (sender/subject/preview/time, star, unread) + reading
  pane with Reply / Reply all / Forward / AI-draft. **Not a chat box.**
- **RingCentral** — a **phone**: recents/voicemail, voicemail w/ waveform +
  transcript + Call back, dial pad, dial bar. WebRTC for video + screen-share.
- **Text (SMS)** — conversation list + bubbles + composer.
- **Shell**: channel switcher across the **top** (real logos, ← → arrows),
  **persistent bottom bar that adapts** per channel (composer / compose / dial bar).

## The AI "catch-up" features (the wow)
Already mocked in `public/index.html` (demo mode) — keep these in the rebuild:
- **"While you were away" modal**: surfaces messages received while out (e.g. Sally's
  email, an SMS lead), each with an **AI-suggested reply** + **Ignore / Edit / Send**,
  stepping through items.
- **Sticky AI call widget**: "Noah's reception AI took a call from Mrs. Jones… took a
  message" + waveform + **Listen to recording / Call back**.

## Avatars
Demo team uses **fun animal headshots** (corgi, husky, fox, cat, owl, red panda,
parrot, pug, retriever) so it feels playful. Currently hosted on an external CDN
(`u.hyperfx.ai/...`, see `ANIMAL_AVATARS` in `public/index.html`). **Localize these
into the repo (or asset host) before production** — external URLs are a demo-phase
shortcut.

## Real-implementation feasibility (per the user)
RingCentral, Slack, and Zapier all expose **developer SDKs with example/drop-in code**
for: call events, recordings, voicemail, AI reception/message-taking, cross-channel
triggers. Implementation = wiring their examples, not building from scratch.
**SearchAtlas** (not Semrush) has a REST API for AI **content generation** (blogs,
landing pages, ad copy) — relevant to a later "content studio" module. Semrush API =
competitive/traffic intel; ConsumerAffairs has **no public API** (partner-only).

## Gotchas (this sandbox)
- **External images are blocked** by the egress proxy here, so animal avatars show
  broken in local Playwright screenshots but **load fine for the user on Vercel.**
- **No database configured** in the sandbox → `/api/*` returns 503 and "Database not
  configured"; this is expected. Use **Demo mode** (toggle on Team view, or
  `localStorage nc_demo_mode=true`) to see populated UI.
- Image-gen MCP outputs to its own sandbox/CDN; bytes can't be copied into this repo
  (separate filesystem + blocked CDN) — that's why avatars are hotlinked for now.
- Dev server: `node server.js` (port 3000). If `EADDRINUSE`, `fuser -k 3000/tcp`.

## Recommended next steps
1. **Pick the build tool** (recommend Lovable) and scaffold Noah Connect from the
   module brief above, using shadcn/ui components — not bespoke CSS.
2. Make the **Office the landing screen**; fold the catch-up modal + AI call widget
   into the shell so it all lives in one app.
3. Build the **adaptive bottom composer** (type / dictate / `/command`) with basic
   RingCentral call-forwarding.
4. Localize avatars; replace demo data with real connectors (Slack/Gmail/RingCentral
   via their SDK drop-ins).
