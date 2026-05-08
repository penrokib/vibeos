# Rokibrain iOS Companion

Native SwiftUI companion app for `app.rokibrain.com`. Sole user: Roki. Used while traveling to approve decisions/drafts and watch the cockpit terminals.

- Bundle ID: `com.rokibrain.ios`
- Min iOS: 17.0
- No third-party SaaS. Auth via BFF `/auth/login`. JWT in Keychain only.

## Tabs

| Tab | Purpose |
|---|---|
| Home | fleet-health card, Saarland T-X.Xh banner, knowledge search, top-3 decisions, top-3 drafts, account quotas |
| Decisions | full pending list, tap → detail Approve / Skip |
| Drafts | full pending list, swipe-approve / swipe-reject |
| Terminals | 9-pane cockpit grid, tap → fullscreen with software keyboard input via WSS |
| Settings | BFF URL, log out, version |

## Hard walls (defense-in-depth — bridge ALSO rejects)

- If the last 10 lines of a pane include `"Switch to extra usage"` or `"Switch to Team plan"` and the user types `2` or `3`, the iOS app blocks the keystroke and shows a confirmation alert. Default action is Cancel. Bridge rejects independently.
- No password ever stored locally — only the JWT returned by the BFF.

## Build (simulator, no signing)

```sh
cd apps/ios
xcodebuild \
  -project Rokibrain.xcodeproj \
  -scheme Rokibrain \
  -destination 'generic/platform=iOS Simulator' \
  -configuration Debug \
  CODE_SIGNING_ALLOWED=NO \
  build
```

## Sideload to a physical iPhone

1. Plug iPhone into Mac via USB-C.
2. Open `apps/ios/Rokibrain.xcodeproj` in Xcode.
3. Xcode → Settings → Accounts → add Roki's Apple ID (free tier OK).
4. Select the `Rokibrain` target → Signing & Capabilities → set the Team to Roki's Apple ID. Bundle ID stays `com.rokibrain.ios`.
5. Select the connected iPhone in the destination dropdown.
6. Press Run (Cmd-R). First launch: on iPhone, Settings → General → VPN & Device Management → trust the developer cert.

Free tier certs expire every 7 days. Re-run from Xcode weekly while traveling.

## Architecture

- `RokibrainApp.swift` — `@main`, `TabView`, AuthStore.
- `Services/Keychain.swift` — minimal generic-password wrapper, service `com.rokibrain.ios`, account `jwt`.
- `Services/APIClient.swift` — URLSession + Codable + JWT bearer header.
- `Services/WSClient.swift` — `URLSessionWebSocketTask` with exponential reconnect.
- `Models/Models.swift` — Codable DTOs for fleet, decisions, drafts, knowledge.
- `Views/*.swift` — five tabs + login.

## Endpoints used (provided by BFF agent)

| Method | Path |
|---|---|
| POST | `/auth/login` |
| GET | `/agency/fleet-status` |
| GET | `/decisions?status=pending` |
| PATCH | `/decisions/:id` |
| GET | `/agency/drafts/pending` |
| POST | `/agency/drafts/:id/approve` |
| POST | `/agency/drafts/:id/reject` |
| GET | `/knowledge/search?q=…&top_k=10` |
| WSS | `/ws/terminal?role=client&token=<jwt>&session=<name>` |

## Not yet (post-trip)

- Voice tab (`/voice/utterance`) — deferred.
- APNS push (needs $99/yr Developer Program).
- SwiftTerm full ANSI renderer — currently plain monospaced live tail. Vendor SwiftTerm via SwiftPM in v2.
- App icon artwork (currently uses AccentColor placeholder).
