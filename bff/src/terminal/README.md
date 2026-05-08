# Terminal WS Gateway

`/ws/terminal` — Socket.IO gateway brokering terminal-mirror traffic between
the rokibrain-bridge daemon on M3 and iOS / macOS clients.

## Handshake

Connect with a Socket.IO client (or compatible) to:

```
wss://app.rokibrain.com/ws/terminal?role=<bridge|client>&token=<JWT>
```

- `token` — JWT issued by `POST /auth/login` (admin) or `POST /devices/pair`
  (device-scoped, 24h TTL). Verified server-side; bad/missing tokens get
  immediate `disconnect`.
- `role` — `bridge` (the M3 daemon) or `client` (iOS / macOS apps).
  Defaults to `client`.

The owner key is derived from the JWT's `email` (falls back to `sub`).
Single-tenant in v1; multi-tenant just works the day we add users.

## Wire envelope

All app-level traffic rides on the Socket.IO event name `message`. The body
is a JSON object with a `type` discriminator.

### Client → server

| `type`        | Required fields                | Meaning |
| ------------- | ------------------------------ | ------- |
| `subscribe`   | `session`                      | Add session to this client's pane-stream subscriptions. |
| `unsubscribe` | `session`                      | Remove session from subscriptions. |
| `keystroke`   | `session`, `data` (string)     | Forwarded to the bridge — daemon runs `tmux send-keys -t <session> "<data>"`. |
| `resize`      | `session`, `cols`, `rows`      | Forwarded to the bridge for pane resize. |

### Bridge → server (broadcast to subscribed clients)

| `type` | Required fields              | Meaning |
| ------ | ---------------------------- | ------- |
| `pane` | `session`, `data` (string)   | Tail bytes captured by `tmux pipe-pane`. UTF-8 — terminal emulator runs client-side (SwiftTerm). |

### Server → client

| Event   | Body                          | Meaning |
| ------- | ----------------------------- | ------- |
| `hello` | `{role, owner}`               | Sent once after handshake auth succeeds. |
| `error` | `{code:"unauthorized"}`       | Sent right before forced disconnect on bad auth. |

## Backpressure

Per-client buffer cap: **1 MB** un-flushed. When a pane burst would push
the counter past the cap, the gateway drops the chunk and resets the
counter. Live tail is what matters; scrollback is fetched out-of-band.
The `data` payload is the active subscription set (`Set<string>`)
maintained per-client in `socket.data.sessions`.

## Lifetime

- **One bridge per owner** — last-write-wins. A second bridge connection
  for the same owner kicks the first.
- **Many clients per owner** — each maintains its own subscription set.
- Disconnects are clean: bridge / client maps drop the socket entry.

## Local smoke test

```sh
# Get a JWT
curl -sS -X POST https://app.rokibrain.com/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"roki@dewx.com","password":"<pw>"}' \
  | jq -r .access_token > /tmp/jwt

# Mock bridge
wscat -c "wss://app.rokibrain.com/ws/terminal?role=bridge&token=$(cat /tmp/jwt)"
> 42["message",{"type":"pane","session":"rokibrain-cto","data":"hello\n"}]

# Mock client (different shell)
wscat -c "wss://app.rokibrain.com/ws/terminal?role=client&token=$(cat /tmp/jwt)"
> 42["message",{"type":"subscribe","session":"rokibrain-cto"}]
> 42["message",{"type":"keystroke","session":"rokibrain-cto","data":"ls\r"}]
```

(`42[...]` is the Socket.IO v4 framing for a `message` event.)
