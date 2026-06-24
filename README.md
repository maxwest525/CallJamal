# 📞 CallJamal – Virtual Office

A production-ready Virtual Office system with SlickText SMS integration and Supabase database. Built for teams of up to 5 employees sharing a single SMS number, at a fraction of the cost of platforms like Roam HQ.

**Cost: ~$10–30/month** (vs. $250–1,000/month for Roam HQ)

---

## 🚀 Features

- **Unified SMS Messaging** — Shared SlickText number for the whole team
- **External SMS** — Send messages to clients from the team number
- **Internal Alerts** — Send SMS alerts to individual team members
- **Broadcast SMS** — Message all active clients at once
- **Incoming Webhook** — Auto-log replies from clients into conversation threads
- **Client Directory** — Full CRUD for client contact management
- **Team Status** — Live presence (Online / Away / Busy / Offline)
- **Google Workspace Sync** — Pull team members directly from your Google directory
- **Conversation History** — All SMS threads grouped by phone number
- **Audit Log** — Every action recorded for compliance

---

## 🏗️ Tech Stack

| Layer      | Technology                        |
|------------|-----------------------------------|
| Frontend   | HTML / CSS / Vanilla JavaScript   |
| Backend    | Node.js + Express                 |
| Database   | Supabase (PostgreSQL)             |
| SMS        | SlickText (shared number)         |
| Auth Sync  | Google Workspace Directory API    |

---

## 📁 Project Structure

```
CallJamal/
├── server.js               # Express server entry point
├── package.json
├── .env.example            # Environment variable template
├── routes/
│   ├── sms.js              # SMS send / broadcast / webhook endpoints
│   ├── users.js            # User management + Google Workspace sync
│   └── clients.js          # Client CRUD + per-client SMS
├── lib/
│   └── supabase.js         # Supabase admin client + helpers
├── database/
│   └── schema.sql          # Full PostgreSQL schema (run in Supabase)
└── public/
    └── index.html          # Single-page dashboard
```

---

## ⚙️ Setup

### 1. Clone & Install

```bash
git clone https://github.com/maxwest525/CallJamal.git
cd CallJamal
npm install
```

### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and fill in all values (see section below).

### 3. Set Up Supabase Database

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Open **SQL Editor** in the Supabase dashboard
3. Paste the contents of `database/schema.sql` and click **Run**
4. Copy your **Project URL** and **Service Role Key** from **Settings → API** into `.env`

### 4. Configure SlickText

1. Log in to [slicktext.com](https://www.slicktext.com)
2. Go to **Account → API Keys** to get your Public and Private keys
3. Set up your shared team phone number
4. Configure the incoming webhook URL to: `https://your-domain.com/api/sms/webhook`

### 5. Configure Google Workspace (optional)

1. In [Google Cloud Console](https://console.cloud.google.com), create a project
2. Enable the **Admin SDK Directory API**
3. Create a **Service Account** and download the JSON key file
4. In Google Workspace Admin, grant the service account **domain-wide delegation** with scope `https://www.googleapis.com/auth/admin.directory.user.readonly`
5. Set `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` in `.env` to the path of the downloaded JSON

### 6. Start the Server

```bash
# Development (auto-restart on file changes)
npm run dev

# Production
npm start
```

Open [http://localhost:3000](http://localhost:3000) to view the dashboard.

---

## 🔑 Environment Variables

| Variable                          | Description                                          |
|-----------------------------------|------------------------------------------------------|
| `PORT`                            | Server port (default: 3000)                         |
| `SUPABASE_URL`                    | Your Supabase project URL                           |
| `SUPABASE_ANON_KEY`               | Supabase anon/public key                            |
| `SUPABASE_SERVICE_ROLE_KEY`       | Supabase service role key (admin access)            |
| `SLICKTEXT_PUBLIC_KEY`            | SlickText API public key                            |
| `SLICKTEXT_PRIVATE_KEY`           | SlickText API private key                           |
| `SLICKTEXT_MAIN_NUMBER`           | Shared team phone number (E.164 format)             |
| `GOOGLE_WORKSPACE_DOMAIN`         | Your Google Workspace domain (e.g. company.com)     |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | Path to Google service account JSON key file        |
| `WEBHOOK_SECRET`                  | Secret for validating incoming SlickText webhooks   |

---

## 📡 API Endpoints

### SMS

| Method | Path                     | Description                              |
|--------|--------------------------|------------------------------------------|
| POST   | `/api/sms/send-external` | Send SMS to a client phone number        |
| POST   | `/api/sms/send-internal` | Send internal alert to a team member     |
| POST   | `/api/sms/broadcast`     | Broadcast SMS to all active clients      |
| POST   | `/api/sms/webhook`       | Incoming SMS webhook (SlickText → server)|
| GET    | `/api/sms/messages`      | List recent messages                     |

### Users

| Method | Path                  | Description                              |
|--------|-----------------------|------------------------------------------|
| GET    | `/api/users`          | List all active users                    |
| GET    | `/api/users/team`     | List team members with extensions        |
| POST   | `/api/users`          | Manually create a user                   |
| PATCH  | `/api/users/:id/status` | Update user status (online/away/etc.)  |
| POST   | `/api/users/sync`     | Sync from Google Workspace               |

### Clients

| Method | Path                            | Description                         |
|--------|---------------------------------|-------------------------------------|
| GET    | `/api/clients`                  | List clients (supports search)      |
| GET    | `/api/clients/:id`              | Get a single client                 |
| POST   | `/api/clients`                  | Create a client                     |
| PATCH  | `/api/clients/:id`              | Update a client                     |
| DELETE | `/api/clients/:id`              | Soft-delete a client                |
| POST   | `/api/clients/:id/sms`          | Send SMS to a specific client       |
| GET    | `/api/clients/:id/conversations`| Get SMS history for a client        |
| GET    | `/api/clients/conversations/all`| All conversation threads            |

### Health

| Method | Path      | Description        |
|--------|-----------|--------------------|
| GET    | `/health` | Health check       |

---

## 🗄️ Database Schema

| Table               | Purpose                                          |
|---------------------|--------------------------------------------------|
| `users`             | Team members synced from Google Workspace        |
| `team_members`      | Employee assignments (up to 5), extensions, roles|
| `clients`           | Client directory with contact info               |
| `sms_conversations` | SMS threads grouped by phone number              |
| `messages`          | All inbound/outbound SMS messages                |
| `activity_log`      | Full audit trail of every action                 |

---

## 🚢 Deployment

### Render / Railway / Heroku

1. Push to GitHub
2. Connect your repo to Render/Railway/Heroku
3. Set all environment variables in the platform dashboard
4. Deploy — the `npm start` command runs automatically

### Manual VPS (Ubuntu)

```bash
# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and install
git clone https://github.com/maxwest525/CallJamal.git /var/www/calljamal
cd /var/www/calljamal
npm install --production

# Set up environment
cp .env.example .env
nano .env  # fill in your values

# Install PM2 for process management
npm install -g pm2
pm2 start server.js --name calljamal
pm2 startup
pm2 save
```

---

## 💰 Cost Breakdown

| Service        | Plan           | Monthly Cost |
|----------------|----------------|-------------|
| Supabase       | Free tier      | $0          |
| SlickText      | Starter        | $29         |
| Hosting (Render)| Free/Starter  | $0–7        |
| Google Workspace| Business Starter| $6/user   |
| **Total**      |                | **~$10–36** |

vs. Roam HQ: **$250–1,000/month** ✅
