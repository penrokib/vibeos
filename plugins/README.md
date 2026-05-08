# plugins/

Community + bundled plugins for vibeOS bridges.

Each plugin is its own npm package with the prefix `vibeos-plugin-*`. Conforms to the `BaseMeshChild` contract from `@vibeos/sdk`.

## Layout

```
plugins/
├── vibeos-plugin-whatsapp/   # bundled, populated cycle 6
├── vibeos-plugin-telegram/   # bundled, populated cycle 14
├── vibeos-plugin-email/      # bundled, populated cycle 15
└── (community plugins published separately to npm)
```

## SDK

See `../sdk/` for `BaseMeshChild` contract + manifest schema. Plugin SDK ships in v1.1.

## Banned platforms

The plugin loader hardcodes a deny list — plugins claiming to bridge any of these are refused at install:

- Signal (defeats their E2E by design)
- Banking apps
- Apple ID / Google account auth
- Government / e-signature platforms
- Stripe checkout / payment-link mutation
