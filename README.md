# ioBroker.victronadapter

Adapter for Victron GX and Cerbo GX systems via Modbus TCP.

## Important repository note

This source package is prepared for this repository name:

```text
https://github.com/FreeProgrammer1/ioBroker.victronadapter
```

The technical ioBroker adapter name remains lowercase:

```text
victronadapter
```

## Features

- Reads Victron GX and Cerbo GX systems via Modbus TCP
- Provides dashboard states for grid, PV, battery, AC loads and essential loads
- Supports controls for selected Victron settings
- Supports automatic discovery with a comma-separated Modbus Unit ID list
- Provides a clean Lovelace card with normal and circular energy-flow examples

## Requirements

- Node.js 22 or newer
- ioBroker js-controller 6.0.11 or newer
- ioBroker Admin 7.6.20 or newer
- Victron GX or Cerbo GX with Modbus TCP enabled
- Network access from ioBroker to the GX device

## Configuration

Configure the adapter instance in ioBroker Admin.

Important settings:

- GX IP address or hostname
- Modbus TCP port, normally `502`
- System Unit ID, normally `100`
- Poll interval
- Automatic discovery
- Comma-separated Unit IDs for discovery

Default discovery list:

```text
100,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247
```

The configured system Unit ID and control Unit ID are always included automatically.

## Lovelace

The adapter can install these files into the configured Lovelace instance:

```text
victronadapter-card.js
victronadapter-flow.yaml
victronadapter-flow-circle.yaml
```

Normal card type:

```yaml
type: custom:victronadapter-flow
```

Circle card type:

```yaml
type: custom:victronadapter-flow-circle
```

The card uses the existing `dashboard.*` adapter states.

## Development

Run local checks:

```bash
npm test
npm run lint
npm run adapter-check
```

## Changelog

### 0.6.5

- Fixed package name back to lowercase `iobroker.victronadapter`.
- Fixed repository metadata to `ioBroker.victronadapter`.
- Removed invalid JSONConfig responsive root attributes.
- Updated `@iobroker/adapter-dev` to `^1.5.0`.
- Updated translations to avoid identical English fallback entries.
- Removed obsolete ignore/changelog files from the npm package.
- Kept adapter behavior unchanged.

Older entries are stored in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## License

MIT License

Copyright (c) 2026 FreeProgrammer1
