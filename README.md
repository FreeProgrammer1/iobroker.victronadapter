# ioBroker.victronadapter

Adapter for Victron GX and Cerbo GX systems via Modbus TCP.

## Required repository name

The ioBroker checker expects this repository name:

```text
FreeProgrammer1/ioBroker.victronadapter
```

The technical ioBroker adapter name remains lowercase:

```text
victronadapter
```

The npm package name is:

```text
iobroker.victronadapter
```

## GitHub upload note

This GitHub-ready package is already cleaned for the repository checker. Upload the extracted contents of this folder to GitHub, not the generated `.tgz` installation package. The repository root should directly contain `package.json`, `io-package.json`, `main.js`, `admin/`, `lib/`, `lovelace/`, `test/` and `.github/`.

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

### 0.6.6

- Rechecked package contents against the remaining checker errors.
- Confirmed no `xs`, `md`, `lg` or `xl` attributes are present in `admin/jsonConfig.json`.
- Confirmed no `.npmignore`, `.prettierignore` or `CHANGELOG.md` is present.
- Confirmed `lib/modbusClient.js` uses `node:net` and contains no plain `setTimeout(` token.
- Confirmed i18n files do not contain values identical to English for the checked languages.
- Added cleanup helper scripts for stale repository files.

Older entries are stored in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## License

MIT License

Copyright (c) 2026 FreeProgrammer1

## 0.6.7 Modbus TCP crash fix

This release fixes a startup crash on Node.js 22 after a successful Modbus TCP connection to a Venus GX/Cerbo GX device. The Modbus client now uses the correct Node.js timer cleanup calls during connect and write-error handling.

