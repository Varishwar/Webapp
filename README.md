# Shagun Workspace

Private, end-to-end encrypted, one-to-one chat with self-destructing messages.  
Single-folder Node.js app — no separate build step, no database.

---

## Quick start

```bash
cd ephemeral-chat
npm install
npm start
# → http://localhost:3000
```

Open two different browser tabs or devices at `http://localhost:3000` to test.

---

## How it works

1. **Register / Login** — bcrypt-hashed passwords, in-memory session tokens. No email or phone.
2. **Creator** clicks "Create Private Room" → gets a unique URL to share.
3. **Partner** opens the link, logs in, and enters the room.
4. Both browsers perform an **ECDH P-256 key exchange** over the WebSocket. A shared **AES-256-GCM** key is derived.
5. All messages are **encrypted in the browser** before leaving the device. The server relays ciphertext only — it never sees plaintext.
6. Messages **auto-delete 10 seconds after the recipient reads them** (on both sides).
7. **Admin-only deletion**: The room creator can delete any message; the partner cannot. Enforced server-side — bypassing the UI won't work.
8. Tab switching / PrintScreen attempts trigger a **black overlay** (best-effort).

---

## File structure

```
ephemeral-chat/
├── package.json       Dependencies + start script
├── server.js          Express + Socket.io + bcrypt + room management
├── public/
│   ├── index.html     Single-page app (all screens)
│   ├── style.css      Dark theme, mobile-first styles
│   ├── crypto.js      ECDH + AES-GCM helpers (Web Crypto API)
│   └── app.js         Complete client logic
└── README.md
```

---

## Security details

| Feature | Implementation |
|---|---|
| Passwords | `bcrypt` with cost factor 12 |
| Encryption | ECDH P-256 key exchange → AES-256-GCM per session |
| Server sees | Only base64 ciphertext + IV — never plaintext |
| Persistence | Zero — all state is in-memory; restart clears everything |
| Admin delete | Validated server-side before broadcasting |
| Screenshot | Overlay on `PrintScreen`, `Cmd+Shift+3/4/5`, tab-switch (best-effort) |

> **HTTPS required in production**: Web Crypto API only works in secure contexts. Both Render and Railway provide HTTPS automatically.

---

## Deployment to Render (free tier — supports WebSockets)

1. Push `ephemeral-chat/` to a GitHub repository (or the whole parent folder).
2. Go to [render.com](https://render.com) → **New → Web Service**.
3. Connect your repo and configure:
   - **Root Directory**: `ephemeral-chat` (if inside a larger repo) or `.` if the root is the project
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Click **Create Web Service**.
5. Render assigns a URL like `https://ephemeral-chat-xxxx.onrender.com`. That's your app — no env vars needed since client and server are the same origin.

> Free Render instances spin down after inactivity. The first load after idle may take ~30 seconds.

---

## Deployment to Railway

1. Install Railway CLI: `npm i -g @railway/cli`
2. From inside `ephemeral-chat/`:
   ```bash
   railway login
   railway init
   railway up
   ```
3. Railway auto-detects Node.js, sets `PORT`, and serves your app.

---

## Notes

- **Accounts are ephemeral too**: credentials are stored in-memory. Restarting the server clears all accounts and rooms. For persistent accounts, replace the `users` Map with a database (e.g., SQLite with `better-sqlite3`).
- **One room = two people max**: a third join attempt is rejected by the server.
- **Screenshot deterrence is partial**: OS-level tools (Snipping Tool, iCloud screen capture, etc.) cannot be blocked by a browser. The overlay covers browser-initiated captures only.
