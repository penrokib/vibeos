# vibeOS — Usage Guide

This guide covers installation, first-launch, pairing each platform, and day-to-day use. For the system architecture, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Prerequisites

- **Mac** running macOS 13 Ventura or later (Mac is the engine; Windows/Linux desktop support ships in v1.1)
- **[Claude Code](https://claude.ai/code)** installed and authenticated — `claude --version` should print a version number
- Internet connection for the vibeos.app BFF (relay + push notifications)
- iPhone running iOS 17+ (optional but recommended — 60% of daily use happens here)

---

## Install

### Option A — One-line installer (ships cycle 31, use option B until then)

```bash
curl -fsSL https://vibeos.app/install.sh | bash
```

The script detects your OS, downloads the signed DMG, mounts it, drags the app to `/Applications`, and opens the first-launch wizard.

### Option B — Build from source (current)

```bash
# 1. Clone
git clone https://github.com/penrokib/vibeos
cd vibeos

# 2. Install dependencies (Node 20+, Yarn 4 required)
yarn install

# 3. Start development build
yarn workspace @vibeos/desktop dev
```

The Electron window opens automatically. The daemon starts as a `utilityProcess` inside the app — you do not need to start it separately.

---

## First-launch wizard

The wizard runs automatically on first open. It walks you through six steps:

**Step 1 — Create your vibeOS account**

Enter your email. You receive a magic link. Click it. A JWT is stored in your Mac Keychain — this is your identity for all your devices.

**Step 2 — Install Claude Code (if not already installed)**

If `claude` is not found in `PATH`, the wizard shows the install command. Follow it, authenticate with your Anthropic account, then return to vibeOS and click "Claude Code is ready."

**Step 3 — Connect Claude Code**

The wizard generates your `claude_desktop_config.json` snippet and copies it to the clipboard. Paste it into your Claude Desktop or Claude Code config, then restart Claude. Click "I've restarted Claude" to verify the MCP handshake.

**Step 4 — Choose your mode**

Select WORK, PERSONAL, or Both. This sets the initial brain-split. You can change it in Settings at any time. WORK and PERSONAL data are stored in separate encrypted databases — they never mix.

**Step 5 — Pair your first platform**

The wizard prompts you to pair at least one comms platform. See the pairing section below. You can skip and pair later in the Connections tab.

**Step 6 — Enable push notifications (iPhone)**

If you have the iOS app installed, enable push notifications for real-time draft and limit-prompt alerts. The wizard shows a QR code to pair your phone to this Mac.

---

## Pairing platforms

Open the **Connections** tab. Click "+ Add account." Choose the platform.

### WhatsApp

1. Click "Pair WhatsApp."
2. A QR code appears in the Connections tab.
3. On your phone: WhatsApp → Settings → Linked Devices → Link a Device → scan the QR.
4. Status changes to "open" within a few seconds.
5. Repeat for each WhatsApp number (work / personal / etc.). Each number runs as its own isolated process.

**Important:** WhatsApp has anti-spam detection. vibeOS enforces a warmup schedule (30 messages/day for days 1-14, then up to 80/day). Trying to send more returns a refusal with the reason — the gate is in the daemon code, not in prompts, so Claude cannot bypass it.

### Telegram

1. Click "Pair Telegram."
2. Enter your phone number. Telegram sends a code.
3. Enter the code in the wizard (or scan the QR shown).
4. Status changes to "open."

### Email (Gmail / IMAP)

**Gmail:**
1. Click "Pair Email → Gmail."
2. The wizard opens a browser window for Google OAuth.
3. Grant access. The token is stored in your Keychain.

**Other IMAP providers:**
1. Click "Pair Email → Other."
2. Enter IMAP host, port, username, and app password (not your login password — generate one in your provider's security settings).

### Discord

*(Ships in v1.1)*

1. Create a Discord bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Copy the bot token.
3. In Settings → Connections → Add → Discord, paste the token.

### LinkedIn

*(Ships in v1.1, requires a Unipile API key)*

1. Sign up at [unipile.com](https://unipile.com) and get an API key.
2. In Settings → Connections → Add → LinkedIn, enter your key and LinkedIn credentials.
3. LinkedIn rate limits are extreme (20/day warm, 80/day mature). vibeOS enforces these.

---

## Day-to-day use

### Reading your inbox

Open the **Mesh** tab. All paired accounts appear in one unified thread list, sorted by last activity. Tap any thread to read the full history.

Filter by platform, account, or WORK/PERSONAL toggle at the top.

### Drafting a reply with Claude

In any Mesh thread, click "Draft with Claude." vibeOS calls `mesh.draft_message()` via MCP, Claude reads the thread context and your persona settings, drafts a reply, and posts it to the Drafts queue.

Alternatively, from Claude Code or Claude Desktop, type naturally:

```
Draft a follow-up to the thread with Acme Corp about the Q3 proposal.
```

Claude uses `mesh.search()` to find the thread, reads the last 20 messages, drafts a reply from the perspective of your `bd-lead-1` persona (or whichever persona is active), and posts it as a pending draft.

### Approving drafts

Open the **Drafts** tab (or the iPhone Drafts screen). Each draft shows:

- Full thread context (last 10 messages)
- The drafted reply
- Persona reasoning (why this tone/angle)
- Similar past drafts (to catch repetition)
- Anti-ban status (will it pass the gate?)

Click **Approve** to send. Click **Reject** to discard. Click **Edit** to modify the text before approving.

On iPhone: swipe the draft card. On Apple Watch (v1.1): tap the draft count complication.

### Voice PTT (Mac)

Press **⌥-Space** (Option + Space) on your Mac. The Quickbar window appears at the center of your screen. Speak your intent. Release the key.

vibeOS transcribes the audio (whisper.cpp, runs locally — audio never leaves your Mac), routes your utterance to the active persona, and either creates a draft or executes the action.

Example: "Reply to the broker thread, ask about the 5-bedroom in Lampung, use a friendly tone in Bahasa." This creates a draft in the Drafts queue. You approve it on your phone or Mac.

Audio is held in RAM during transcription and immediately discarded — it is never written to disk.

### Cockpit — terminal control from phone

The **Cockpit** tab mirrors every tmux pane on every Mac in your mesh. You can read terminal output and send keystrokes.

Use case: Claude Code hits a rate-limit prompt on your Mac ("1: stop, 2: extra usage, 3: team plan"). Cockpit shows this prompt. On your iPhone, tap "1" to dismiss it safely. vibeOS enforces a safety wall: sending "2" or "3" is blocked (those trigger billing changes), and you must confirm before sending any keystroke to a Claude Code session.

### WORK / PERSONAL toggle

The top of the app (and top of the iPhone screen) has a WORK / PERSONAL segmented toggle. Switching changes the entire data view — inbox, drafts, personas, search — to the other brain. The two brains use separate encryption keys. Nothing ever crosses between them.

---

## Troubleshooting

**1. Claude Code MCP shows "vibeos not connected"**

Confirm the `vibeos-mcp` shim is installed: run `which vibeos-mcp`. If not found, the daemon did not install the shim yet. Open vibeOS → Settings → Claude Code → "Reinstall MCP shim."

**2. WhatsApp QR expired before I scanned it**

The QR refreshes every 60 seconds. Click "Regenerate QR" in the Connections tab. Each regeneration counts as a pairing attempt — vibeOS limits this to 1 attempt per hour per account to avoid triggering WhatsApp's linking-attempt ban.

**3. Drafts show "refused — daily cap reached"**

You have hit the per-account daily message cap for that platform. vibeOS will not send more until midnight (user timezone). You can approve the drafts the next day, or Claude will retry and offer to reschedule. The cap cannot be overridden via Claude prompts — only the `--unwarmed=true` flag (for established accounts with prior history) relaxes the warmup window.

**4. BFF relay shows "unreachable"**

Check `status.vibeos.app` for service status. If your Mac is offline, the BFF cannot relay pushes to your phone, but your phone will show the last cached snapshot. Drafts approval is disabled while offline to avoid replay-order issues.

**5. "mesh.list_accounts() returns empty"**

No accounts are paired yet, or the daemon is not running. Check: vibeOS taskbar icon → "Daemon status." If stopped, click "Restart daemon."

**6. Telegram pairing stuck at "waiting for code"**

Telegram sometimes sends the code to a previously linked device. Check all your Telegram clients for the code. If still stuck, click "Cancel" and re-pair.

**7. Email drafts are not sending**

Gmail OAuth tokens expire. Go to Settings → Connections → your Gmail account → "Re-authenticate."

**8. The Cockpit tab shows a blank pane**

The bridge-mac child connects to your Mac's tmux server. Verify tmux is running: `tmux ls` in a terminal. If no sessions exist, Cockpit has nothing to mirror. Start a tmux session: `tmux new -s work`.

**9. Voice PTT (⌥-Space) does not open the Quickbar**

Another app may have claimed that hotkey. Go to Settings → Voice → change the hotkey. Also verify vibeOS has Accessibility permission in System Settings → Privacy & Security → Accessibility.

**10. iPhone app shows "Last synced X minutes ago" banner**

The iPhone cannot reach the BFF or your Mac. Common causes: Mac is asleep (vibeOS requires the Mac to be awake), or the BFF has a transient outage (check status.vibeos.app). Drafts approval is intentionally disabled in this state.

---

For architecture details that explain *why* these behaviors exist, see [ARCHITECTURE.md](ARCHITECTURE.md). For security questions, see [SECURITY.md](SECURITY.md).
