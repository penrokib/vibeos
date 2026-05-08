# vibeOS Plugin SDK

This guide is for community developers who want to build a vibeOS plugin — a new comms platform bridge that integrates into the unified `mesh.*` inbox.

> **Status:** The Plugin SDK (`@vibeos/sdk`) ships in v1.1. This document describes the final API so you can start building now. The npm package does not exist yet — follow the repo and watch for the `sdk-v1` tag.

---

## What a plugin is

A vibeOS plugin is an npm package that implements the `BaseMeshChild` contract from `@vibeos/sdk`. When installed, vibeOS spawns your plugin as a separate OS process, supervised by the daemon. Your plugin receives messages from the platform and writes them to the unified inbox. The daemon handles anti-ban gating, encryption, and all sends — your plugin's `send()` method is called only after the gate passes.

---

## The `BaseMeshChild` contract

```typescript
import { BaseMeshChild, MeshChildContext, MeshChat, MeshMessage } from '@vibeos/sdk';

export default class MyPlatformChild extends BaseMeshChild {
  // Every plugin MUST declare a static manifest.
  static manifest = {
    platform: 'my-platform',        // lowercase, alphanumeric, hyphens ok
    version: '1.0.0',               // semver
    requiredScopes: ['chat:read', 'chat:write'],  // platform-specific OAuth scopes
    bannedCheck: [],                 // SDK enforces the global deny list automatically;
                                     // list any additional platform-specific banned ops here
    pairFlow: 'oauth',              // 'oauth' | 'token' | 'qr' | 'credentials'
  };

  /**
   * Called once when the user first pairs this account.
   * For pairFlow='oauth': open a browser, complete the OAuth dance, store the token.
   * For pairFlow='token': prompt the user for a token in the wizard.
   * For pairFlow='qr': generate and display a QR code.
   * ctx.storeSecret(key, value) stores to macOS Keychain via daemon (never disk plaintext).
   */
  async pair(ctx: MeshChildContext): Promise<void> {
    const token = await ctx.promptToken('Paste your My Platform API key:');
    await ctx.storeSecret('api-token', token);
  }

  /**
   * Called on startup (after pair). Re-authenticate using stored secrets.
   * ctx.loadSecret(key) reads from Keychain.
   */
  async connect(ctx: MeshChildContext): Promise<void> {
    const token = await ctx.loadSecret('api-token');
    this.client = new MyPlatformClient(token);
    this.client.onMessage((msg) => this.emit('message', msg));
  }

  /**
   * Return the chat list for this account.
   * Sorted by last activity, newest first.
   */
  async listChats(): Promise<MeshChat[]> {
    const threads = await this.client.getThreads();
    return threads.map((t) => ({
      id: t.id,
      displayName: t.name,
      lastMessageAt: t.updatedAt,
      unreadCount: t.unread,
      platform: 'my-platform',
    }));
  }

  /**
   * Return messages in a thread.
   * Newest first. The daemon caches these — only fetch what changed since `since`.
   */
  async listMessages(chatId: string, since?: Date): Promise<MeshMessage[]> {
    const msgs = await this.client.getMessages(chatId, { since });
    return msgs.map((m) => ({
      id: m.id,
      chatId,
      from: m.authorId,
      text: m.content,
      ts: m.createdAt,
      platform: 'my-platform',
    }));
  }

  /**
   * Send a message. Called by the daemon ONLY after all anti-ban gates pass.
   * Do NOT implement your own rate limiting here — the daemon handles it.
   * Return the provider's message ID on success.
   */
  async send(chatId: string, text: string): Promise<{ id: string }> {
    const result = await this.client.sendMessage(chatId, text);
    return { id: result.messageId };
  }

  /**
   * Called when the user revokes this account in Connections tab.
   * Clean up: revoke tokens, close connections.
   */
  async unpair(ctx: MeshChildContext): Promise<void> {
    const token = await ctx.loadSecret('api-token');
    await this.client.revokeToken(token);
    await ctx.deleteSecret('api-token');
  }
}
```

---

## Manifest format

The `static manifest` object is validated by the plugin loader at install time.

| Field | Type | Required | Description |
|---|---|---|---|
| `platform` | `string` | yes | Lowercase identifier, e.g. `'slack'`. Must not match any banned platform name. |
| `version` | `string` | yes | semver, e.g. `'1.0.0'` |
| `requiredScopes` | `string[]` | yes | OAuth / API scopes your plugin needs. Shown to the user at install. |
| `bannedCheck` | `string[]` | no | Additional ops your plugin refuses to perform (on top of the global deny list). |
| `pairFlow` | `'oauth' \| 'token' \| 'qr' \| 'credentials'` | yes | Which pairing wizard flow to show. |
| `displayName` | `string` | no | Human name shown in Connections tab. Defaults to `platform` title-cased. |
| `iconUrl` | `string` | no | URL to a 64×64 PNG icon. Shown in Connections tab and marketplace. |
| `homepage` | `string` | no | URL to plugin's GitHub or docs. Shown in marketplace listing. |

---

## Banned platforms

The plugin loader has a hardcoded denylist. Any plugin whose `manifest.platform` matches (exact or contains) any of these strings is refused at install with a clear error message:

```
signal
banking
apple-id
google-account
government
e-sign
docusign
hellosign
stripe-checkout
paypal-pay
lemon-squeezy-pay
```

This list is hardcoded in `apps/desktop/src/daemon/plugin-loader.ts` and is not configurable by users or plugin manifests. It enforces vibeOS's safety policy: platforms where bridging defeats the purpose (Signal's E2E), violates ToS (Signal again), or creates unacceptable financial/legal blast radius.

Do not build a plugin for these platforms. If you believe a platform has been incorrectly banned, open an issue with your reasoning.

---

## Hello World plugin walkthrough

Let's build `vibeos-plugin-mastodon` — a read-only Mastodon bridge.

### 1. Scaffold the package

```bash
mkdir vibeos-plugin-mastodon
cd vibeos-plugin-mastodon
yarn init -y
yarn add @vibeos/sdk
yarn add -D typescript @types/node
```

`package.json` — add the vibeOS plugin entry point:

```json
{
  "name": "vibeos-plugin-mastodon",
  "version": "1.0.0",
  "main": "dist/index.js",
  "vibeos": {
    "plugin": true
  }
}
```

### 2. Implement `BaseMeshChild`

`src/index.ts`:

```typescript
import { BaseMeshChild, MeshChildContext, MeshChat, MeshMessage } from '@vibeos/sdk';
import { createRestAPIClient } from 'masto';

export default class MastodonChild extends BaseMeshChild {
  static manifest = {
    platform: 'mastodon',
    version: '1.0.0',
    requiredScopes: ['read:statuses', 'read:notifications'],
    bannedCheck: [],
    pairFlow: 'credentials' as const,
    displayName: 'Mastodon',
  };

  private client!: ReturnType<typeof createRestAPIClient>;

  async pair(ctx: MeshChildContext): Promise<void> {
    const instance = await ctx.promptToken('Mastodon instance (e.g. mastodon.social):');
    const token = await ctx.promptToken('Access token (from Account → Preferences → Development):');
    await ctx.storeSecret('instance', instance);
    await ctx.storeSecret('access-token', token);
  }

  async connect(ctx: MeshChildContext): Promise<void> {
    const instance = await ctx.loadSecret('instance');
    const token = await ctx.loadSecret('access-token');
    this.client = createRestAPIClient({
      url: `https://${instance}`,
      accessToken: token,
    });
  }

  async listChats(): Promise<MeshChat[]> {
    // Mastodon: treat the home timeline as one "chat"
    return [{
      id: 'home',
      displayName: 'Home Timeline',
      lastMessageAt: new Date(),
      unreadCount: 0,
      platform: 'mastodon',
    }];
  }

  async listMessages(chatId: string, since?: Date): Promise<MeshMessage[]> {
    const statuses = await this.client.v1.timelines.home.list({ limit: 40 });
    return statuses.map((s) => ({
      id: s.id,
      chatId: 'home',
      from: s.account.acct,
      text: s.content.replace(/<[^>]+>/g, ''), // strip HTML
      ts: new Date(s.createdAt),
      platform: 'mastodon',
    }));
  }

  // Read-only plugin — send() is not implemented
  // The daemon will show "Sending not supported" in the draft UI
}
```

### 3. Build + install locally

```bash
yarn tsc
vibeos plugin install ./vibeos-plugin-mastodon
```

The daemon reloads. Open the Connections tab. You should see "Mastodon" as an available platform.

### 4. Pair the account

Click "Add account → Mastodon." Enter your instance and access token. The plugin pairs and starts syncing your home timeline into the unified Mesh inbox.

---

## Distribution

### npm convention

Publish your plugin to npm with the `vibeos-plugin-` prefix:

```bash
npm publish --access public
```

Users install via:

```bash
vibeos plugin install vibeos-plugin-mastodon
```

vibeOS discovers installed plugins by scanning `node_modules` for packages with `"vibeos": { "plugin": true }` in `package.json`.

### Community marketplace (v1.1)

vibeOS v1.1 will ship an in-app marketplace browser. To appear in it, submit a PR to `plugins/registry.json` in this repo with your plugin's name, description, npm package name, and homepage URL. The registry is curated — not every submission is accepted, but the bar is low: working, safe, and not banned.

### Signing (v1.1+)

Starting in v1.1, plugins can be published with a GPG-signed manifest. The marketplace shows a "Verified publisher" badge for signed plugins. In v1, plugins are unsigned and vibeOS shows a one-time warning at install. In v2, signing will be mandatory for marketplace listings.

To sign your plugin's manifest:
```bash
vibeos plugin sign ./vibeos-plugin-mastodon   # requires GPG key registered with vibeOS
```

---

## Plugin sandbox

Your plugin runs as a separate OS process. The daemon mediates all access:

- You can call `ctx.storeSecret()` / `ctx.loadSecret()` — daemon writes to Keychain, plugin never touches it directly.
- You can emit `'message'` events — daemon routes them to the unified inbox.
- You cannot call `mesh.send_draft()` directly — your `send()` method is called by the daemon only after anti-ban gates pass.
- You cannot read other accounts' sessions.
- You cannot access the renderer or main process directly.

This isolation means a crash in your plugin does not crash the daemon or other accounts.

---

## Questions and support

- Open an issue: [github.com/penrokib/vibeos/issues](https://github.com/penrokib/vibeos/issues)
- Label your issue `plugin-sdk`
- For the architecture of the daemon ↔ child IPC: [ARCHITECTURE.md](ARCHITECTURE.md)
- For security policies affecting plugins: [SECURITY.md](SECURITY.md)
