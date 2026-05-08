# mobile/

vibeOS iOS + watchOS Swift companion. **Not** a yarn workspace — managed via Swift Package Manager / Xcode.

Will be populated in cycle 3 by migrating `apps/ios/` from `penrokib/rokibrain.com`.

## Build

```bash
# After cycle 3:
xed mobile/
# or
swift build --package-path mobile/
```

## Targets

- `vibeOS-iOS` — main iPhone app (extends apps/ios PR #29)
- `vibeOS-Watch` — watchOS companion (v1.1, requires Apple Developer Program)
- `vibeOS-Shared` — shared models + crypto (libsodium binding)
