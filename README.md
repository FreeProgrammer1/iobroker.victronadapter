# ioBroker.VictronAdapter

ioBroker adapter for Victron GX / Cerbo GX systems via Modbus TCP.

Repository name: `ioBroker.VictronAdapter`  
ioBroker adapter ID: `victronadapter`  
npm package name: `iobroker.victronadapter`

## Important

Version 0.6.1 only adds project metadata and adapter-check support files. The runtime source code was intentionally kept unchanged.

## Features

- Reads Victron GX / Cerbo GX data via Modbus TCP
- Creates dashboard states for grid, PV, battery, AC loads and essential loads
- Supports automatic discovery using a comma-separated Modbus Unit ID list
- Optional control states for supported Victron settings
- Installs one clean Lovelace custom card file and two YAML examples

## Requirements

- ioBroker js-controller >= 6.0.11
- Node.js >= 20
- Victron GX / Cerbo GX with Modbus TCP enabled
- Network access from ioBroker to the GX device

## Installation from local TGZ

```bash
cd /opt/iobroker
npm i /path/to/iobroker.victronadapter-0.6.1.tgz
iobroker upload victronadapter
iobroker add victronadapter
```

## Installation from GitHub

```bash
cd /opt/iobroker
iobroker url https://github.com/gehteuchnichtsanandroid56/ioBroker.VictronAdapter
```

Then create or start an instance in ioBroker Admin.

## Lovelace

The adapter writes these files into the configured Lovelace instance, usually:

```text
/opt/iobroker/iobroker-data/files/lovelace.0/cards/
```

Files:

```text
victronadapter-card.js
victronadapter-flow.yaml
victronadapter-flow-circle.yaml
```

Normal card:

```yaml
type: custom:victronadapter-flow
title: Energiefluss
subtitle: Victron Adapter
show_details: true
show_debug: true
```

Circle card:

```yaml
type: custom:victronadapter-flow-circle
title: Energiefluss
subtitle: Victron Adapter
show_details: true
transparent_background: true
show_debug: true
```

## Configuration

Main settings:

- GX IP address or hostname
- Modbus TCP port, normally `502`
- System Unit ID, normally `100`
- Poll interval
- Automatic discovery enabled/disabled
- Comma-separated Unit IDs for discovery

Default discovery list:

```text
100,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247
```

The configured system Unit ID and control Unit ID are always included automatically.

## Development and checks

Run syntax checks:

```bash
npm test
```

Dry-run package creation:

```bash
npm run test:package
```

Run ioBroker adapter check:

```bash
npm run adapter-check
```

GitHub Actions also runs the official ioBroker testing action on every push and pull request.

## License

MIT


## 0.6.2 Lovelace circle view

The circular Lovelace card now has a visibly different layout:

- round nodes for PV, grid, battery, AC loads and essential loads
- central system hub
- animated flow dots
- direction labels such as `PV → Anlage`, `Netz → Anlage`, `Anlage → Netz`, `Anlage → Akku` and `Akku → Anlage`
- no new adapter states are required; the card only uses existing `dashboard.*` values

Use:

```yaml
type: custom:victronadapter-flow-circle
title: Energiefluss
subtitle: Victron Adapter
show_details: true
transparent_background: true
show_debug: true
```
