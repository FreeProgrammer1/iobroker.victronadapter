'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const utils = require('@iobroker/adapter-core');
const { ModbusTcpClient } = require('./lib/modbusClient');
const {
    SYSTEM_REGISTERS,
    FLOW_STATES,
    CONTROL_REGISTERS,
    DEVICE_PROFILES,
    getRegisterLength,
    decodeRegisters,
    encodeValue,
    stateCommon
} = require('./lib/registerMap');

class VictronHouseControl extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'victronadapter'
        });

        this.client = null;
        this.pollTimer = null;
        this.scanTimer = null;
        this.isPolling = false;
        this.isScanning = false;
        this.discoveredDevices = new Map();
        this.controlByStateId = new Map();
        this.rawPrefix = 'raw.write';
        this.lastValues = new Map();
        this.isStopping = false;

        this.on('ready', () => this.onReady());
        this.on('stateChange', (id, state) => this.onStateChange(id, state));
        this.on('unload', callback => this.onUnload(callback));
    }

    async onReady() {
        try {
            await this.setStateAsync('info.connection', false, true);
            this.normalizeConfig();
            this.client = new ModbusTcpClient({
                host: this.config.host,
                port: this.config.port,
                timeout: this.config.timeout,
                logger: this.log
            });

            await this.createBaseObjects();
            await this.createSystemObjects();
            await this.createFlowObjects();
            await this.createDashboardObjects();
            await this.createViewObjects();
            await this.createControlObjects();
            if (this.config.autoCreateRawWriteObjects) {
                await this.createRawWriteObjects();
            }
            await this.installLovelaceCard();

            this.subscribeStates('controls.*');
            this.subscribeStates(`${this.rawPrefix}.*`);

            await this.pollOnce();
            this.schedulePolling();

            if (this.config.enableDeviceScan) {
                await this.scanDevices();
                this.scheduleScan();
            }
        } catch (error) {
            this.log.error(`Startup failed: ${error.message}`);
            this.schedulePolling();
        }
    }

    normalizeConfig() {
        const cfg = this.config;
        const originalHost = String(cfg.host || '');
        const trimmedHost = originalHost.trim();
        const cleanedHost = trimmedHost.replace(/\s+/g, '');
        cfg.host = cleanedHost;
        cfg.port = Number(cfg.port || 502);
        cfg.timeout = Number(cfg.timeout || 3000);
        cfg.pollInterval = Number(cfg.pollInterval || 2000);
        if (cfg.pollInterval === 5000) {
            cfg.pollInterval = 2000;
            this.log.info('Old default poll interval 5000 ms detected; optimized to 2000 ms for the Lovelace live dashboard.');
        }
        cfg.unitIdSystem = Number(cfg.unitIdSystem || 100);
        cfg.controlUnitId = Number(cfg.controlUnitId || cfg.unitIdSystem || 100);
        const defaultScanUnitIds = '100,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247';
        if (!cfg.scanUnitIds) {
            if (cfg.scanFrom || cfg.scanTo) {
                const from = Math.max(1, Math.min(255, Number(cfg.scanFrom || 223)));
                const to = Math.max(1, Math.min(255, Number(cfg.scanTo || 247)));
                const range = [];
                for (let id = Math.min(from, to); id <= Math.max(from, to); id++) range.push(id);
                cfg.scanUnitIds = [cfg.unitIdSystem, cfg.controlUnitId, ...range].join(',');
            } else {
                cfg.scanUnitIds = defaultScanUnitIds;
            }
        }
        cfg.scanUnitIds = this.normalizeUnitIdList(cfg.scanUnitIds, [cfg.unitIdSystem, cfg.controlUnitId], defaultScanUnitIds);
        cfg.scanInterval = Number(cfg.scanInterval || 300000);
        cfg.writeSafetyMinW = Number(cfg.writeSafetyMinW ?? -30000);
        cfg.writeSafetyMaxW = Number(cfg.writeSafetyMaxW ?? 30000);
        cfg.installLovelaceCard = cfg.installLovelaceCard !== false;
        cfg.lovelaceInstance = String(cfg.lovelaceInstance || 'lovelace.0').trim() || 'lovelace.0';
        cfg.restartLovelaceAfterCardInstall = cfg.restartLovelaceAfterCardInstall !== false;

        if (trimmedHost && cleanedHost !== trimmedHost) {
            this.log.warn(`GX host/IP contained spaces and was normalized from '${trimmedHost}' to '${cleanedHost}'`);
        }
        if (!cfg.host) {
            throw new Error('No GX host/IP configured');
        }
        if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
            throw new Error(`Invalid Modbus TCP port '${cfg.port}'`);
        }
        if (!Number.isInteger(cfg.unitIdSystem) || cfg.unitIdSystem < 0 || cfg.unitIdSystem > 255) {
            throw new Error(`Invalid system Unit-ID '${cfg.unitIdSystem}'`);
        }
        if (!Number.isInteger(cfg.controlUnitId) || cfg.controlUnitId < 0 || cfg.controlUnitId > 255) {
            throw new Error(`Invalid control Unit-ID '${cfg.controlUnitId}'`);
        }
        if (cfg.installLovelaceCard && !/^lovelace\.\d+$/.test(cfg.lovelaceInstance)) {
            this.log.warn(`Invalid Lovelace instance '${cfg.lovelaceInstance}', using lovelace.0`);
            cfg.lovelaceInstance = 'lovelace.0';
        }
    }

    schedulePolling() {
        if (this.isStopping) return;
        this.clearTimer('pollTimer');
        this.pollTimer = this.setInterval(() => this.pollOnce(), Math.max(1000, this.config.pollInterval));
    }

    scheduleScan() {
        if (this.isStopping) return;
        this.clearTimer('scanTimer');
        this.scanTimer = this.setInterval(() => this.scanDevices(), Math.max(60000, this.config.scanInterval));
    }

    clearTimer(name) {
        if (this[name]) {
            this.clearInterval(this[name]);
            this[name] = null;
        }
    }

    isShutdownError(error) {
        const message = String(error && error.message ? error.message : error || '');
        return this.isStopping || /DB closed|Connection is closed|Modbus connection closed|Adapter is stopping/i.test(message);
    }

    isUnitTimeoutError(error) {
        const message = String(error && error.message ? error.message : error || '');
        return error && (error.code === 'TIMEOUT' || /timeout|timed out|connection closed|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED/i.test(message));
    }

    formatScanError(error) {
        const message = String(error && error.message ? error.message : error || 'unknown error');
        const code = error && error.code !== undefined ? `, code=${error.code}` : '';
        return `${message}${code}`;
    }

    async safeSetStateAsync(id, value, ack = true) {
        if (this.isStopping) return false;
        try {
            await this.setStateAsync(id, value, ack);
            return true;
        } catch (error) {
            if (this.isShutdownError(error)) {
                this.log.debug(`State update skipped during shutdown for ${id}: ${error.message}`);
                return false;
            }
            throw error;
        }
    }

    async ensureChannelObject(objectId, name, desc, native = {}) {
        const nextObject = {
            type: 'channel',
            common: { name, desc },
            native
        };
        const existing = await this.getObjectAsync(objectId);
        if (existing) {
            await this.setObjectAsync(objectId, {
                ...existing,
                type: 'channel',
                common: {
                    ...(existing.common || {}),
                    ...nextObject.common
                },
                native: {
                    ...(existing.native || {}),
                    ...nextObject.native
                }
            });
        } else {
            await this.setObjectNotExistsAsync(objectId, nextObject);
        }
    }

    async createBaseObjects() {
        await this.ensureChannelObject('system', 'Victron Systemwerte', 'Direkt gelesene Systemwerte vom Cerbo/GX, zum Beispiel Netz, Batterie, PV und Hausverbrauch.');
        await this.ensureChannelObject('flow', 'Energiefluss berechnet', 'Berechnete, gut verständliche Werte für Energiezentrale und Visualisierung.');
        await this.ensureChannelObject('controls', 'ESS Steuerung', 'Schreibbare Steuerpunkte für ESS, Einspeisung, Batterie und Netz-Sollwerte. Schreiben muss in der Adapterkonfiguration freigegeben werden.');
        await this.ensureChannelObject('devices', 'Gefundene Victron Geräte', 'Automatisch erkannte Victron-Dienste und Geräte über Modbus Unit-IDs.');
        await this.ensureChannelObject('status', 'Adapterstatus', 'Statusinformationen zur Verbindung, Abfrage und Geräteerkennung.');
        await this.ensureStateObject('status.lastPoll', { id: 'lastPoll', name: 'Letzte erfolgreiche Abfrage', description: 'Zeitpunkt der letzten erfolgreichen Datenabfrage.', type: 'string', role: 'date' }, false);
        await this.ensureStateObject('status.lastError', { id: 'lastError', name: 'Letzter Fehler', description: 'Letzte Fehler- oder Warnmeldung des Adapters.', type: 'string', role: 'text' }, false);
        await this.ensureStateObject('status.discoveredCount', { id: 'discoveredCount', name: 'Anzahl erkannter Geräteprofile', description: 'Anzahl automatisch erkannter Victron-Geräteprofile.', type: 'number', role: 'value' }, false);
        await this.ensureChannelObject('lovelace', 'Lovelace Visualisierung', 'Status der automatisch installierten Victron-Energieflusskarte für ioBroker Lovelace.');
        await this.ensureStateObject('lovelace.cardInstalled', { id: 'cardInstalled', name: 'Lovelace-Karte installiert', description: 'Zeigt an, ob die Victron-Energieflusskarte erfolgreich in die Lovelace-Instanz kopiert wurde.', type: 'boolean', role: 'indicator' }, false);
        await this.ensureStateObject('lovelace.cardPath', { id: 'cardPath', name: 'Pfad der Lovelace-Karte', description: 'Zielpfad der installierten Custom Card in der Lovelace-Instanz.', type: 'string', role: 'text' }, false);
        await this.ensureStateObject('lovelace.cardError', { id: 'cardError', name: 'Lovelace-Kartenfehler', description: 'Letzter Fehler bei Installation oder Aktualisierung der Lovelace-Karte.', type: 'string', role: 'text' }, false);
        await this.ensureStateObject('lovelace.lastRestart', { id: 'lastRestart', name: 'Letzter Lovelace-Neustart', description: 'Zeitpunkt, an dem der Adapter die Lovelace-Instanz zuletzt wegen eines Kartenupdates neu gestartet hat.', type: 'string', role: 'date' }, false);
    }

    async installLovelaceCard() {
        if (!this.config.installLovelaceCard) {
            await this.setStateAsync('lovelace.cardInstalled', false, true);
            await this.setStateAsync('lovelace.cardError', 'Automatische Lovelace-Installation ist deaktiviert.', true);
            return;
        }

        const instance = this.config.lovelaceInstance || 'lovelace.0';
        const targetFiles = [
            'cards/victronadapter-card.js'
        ];
        const yamlFiles = [
            'cards/victronadapter-flow.yaml',
            'cards/victronadapter-flow-circle.yaml'
        ];
        const statePath = [...targetFiles, ...yamlFiles].map(file => `/${instance}/${file}`).join(', ');

        try {
            const lovelaceObj = await this.getForeignObjectAsync(`system.adapter.${instance}`);
            if (!lovelaceObj) {
                const msg = `Lovelace-Instanz ${instance} wurde nicht gefunden. Karte kann erst installiert werden, wenn der Lovelace-Adapter existiert.`;
                await this.setStateAsync('lovelace.cardInstalled', false, true);
                await this.setStateAsync('lovelace.cardPath', statePath, true);
                await this.setStateAsync('lovelace.cardError', msg, true);
                this.log.warn(msg);
                return;
            }

            // Clean up old duplicate Lovelace files from previous adapter names. This prevents many
            // duplicate card entries in the Lovelace card picker.
            await this.cleanupOldVictronLovelaceFiles(instance, [...targetFiles, ...yamlFiles]);

            const sourcePath = path.join(__dirname, 'lovelace', 'victronadapter-card.js');
            const cardSource = await fs.readFile(sourcePath, 'utf8');
            const valueYaml = [
                'values:',
                '  last_update_ms:',
                '    - sensor.victronadapter_0_dashboard_last_update_ms',
                '    - victronadapter.0.dashboard.last_update_ms',
                '  grid_total:',
                '    - sensor.victronadapter_0_dashboard_grid_total',
                '    - victronadapter.0.dashboard.grid_total',
                '  grid_l1:',
                '    - sensor.victronadapter_0_dashboard_grid_l1',
                '    - victronadapter.0.dashboard.grid_l1',
                '  grid_l2:',
                '    - sensor.victronadapter_0_dashboard_grid_l2',
                '    - victronadapter.0.dashboard.grid_l2',
                '  grid_l3:',
                '    - sensor.victronadapter_0_dashboard_grid_l3',
                '    - victronadapter.0.dashboard.grid_l3',
                '  grid_status:',
                '    - sensor.victronadapter_0_dashboard_grid_status',
                '    - victronadapter.0.dashboard.grid_status',
                '  pv_total:',
                '    - sensor.victronadapter_0_dashboard_pv_total',
                '    - victronadapter.0.dashboard.pv_total',
                '  pv_ac:',
                '    - sensor.victronadapter_0_dashboard_pv_ac',
                '    - victronadapter.0.dashboard.pv_ac',
                '  pv_ac_l1:',
                '    - sensor.victronadapter_0_dashboard_pv_ac_l1',
                '    - victronadapter.0.dashboard.pv_ac_l1',
                '  pv_ac_l2:',
                '    - sensor.victronadapter_0_dashboard_pv_ac_l2',
                '    - victronadapter.0.dashboard.pv_ac_l2',
                '  pv_ac_l3:',
                '    - sensor.victronadapter_0_dashboard_pv_ac_l3',
                '    - victronadapter.0.dashboard.pv_ac_l3',
                '  pv_dc:',
                '    - sensor.victronadapter_0_dashboard_pv_dc',
                '    - victronadapter.0.dashboard.pv_dc',
                '  house_total:',
                '    - sensor.victronadapter_0_dashboard_house_total',
                '    - victronadapter.0.dashboard.house_total',
                '  ac_loads_total:',
                '    - sensor.victronadapter_0_dashboard_ac_loads_total',
                '    - victronadapter.0.dashboard.ac_loads_total',
                '  ac_loads_l1:',
                '    - sensor.victronadapter_0_dashboard_ac_loads_l1',
                '    - victronadapter.0.dashboard.ac_loads_l1',
                '  ac_loads_l2:',
                '    - sensor.victronadapter_0_dashboard_ac_loads_l2',
                '    - victronadapter.0.dashboard.ac_loads_l2',
                '  ac_loads_l3:',
                '    - sensor.victronadapter_0_dashboard_ac_loads_l3',
                '    - victronadapter.0.dashboard.ac_loads_l3',
                '  essential_loads_total:',
                '    - sensor.victronadapter_0_dashboard_essential_loads_total',
                '    - victronadapter.0.dashboard.essential_loads_total',
                '  essential_loads_l1:',
                '    - sensor.victronadapter_0_dashboard_essential_loads_l1',
                '    - victronadapter.0.dashboard.essential_loads_l1',
                '  essential_loads_l2:',
                '    - sensor.victronadapter_0_dashboard_essential_loads_l2',
                '    - victronadapter.0.dashboard.essential_loads_l2',
                '  essential_loads_l3:',
                '    - sensor.victronadapter_0_dashboard_essential_loads_l3',
                '    - victronadapter.0.dashboard.essential_loads_l3',
                '  battery_soc:',
                '    - sensor.victronadapter_0_dashboard_battery_soc',
                '    - victronadapter.0.dashboard.battery_soc',
                '  battery_power:',
                '    - sensor.victronadapter_0_dashboard_battery_power',
                '    - victronadapter.0.dashboard.battery_power',
                '  battery_voltage:',
                '    - sensor.victronadapter_0_dashboard_battery_voltage',
                '    - victronadapter.0.dashboard.battery_voltage',
                '  battery_current:',
                '    - sensor.victronadapter_0_dashboard_battery_current',
                '    - victronadapter.0.dashboard.battery_current',
                '  battery_temperature:',
                '    - sensor.victronadapter_0_dashboard_battery_temperature',
                '    - victronadapter.0.dashboard.battery_temperature',
                '  battery_status:',
                '    - sensor.victronadapter_0_dashboard_battery_status',
                '    - victronadapter.0.dashboard.battery_status',
                '  surplus:',
                '    - sensor.victronadapter_0_dashboard_surplus',
                '    - victronadapter.0.dashboard.surplus'
            ].join('\n');
            const yamlSourceClassic = [
                'type: custom:victronadapter-flow',
                'title: Energiefluss',
                'subtitle: Victron Adapter',
                'show_details: true',
                'show_debug: true',
                valueYaml,
                ''
            ].join('\n');
            const yamlSourceCircle = [
                'type: custom:victronadapter-flow-circle',
                'title: Energiefluss',
                'subtitle: Victron Adapter',
                'show_details: true',
                'transparent_background: true',
                'show_debug: true',
                valueYaml,
                ''
            ].join('\n');

            for (const targetFile of targetFiles) {
                await this.writeFileAsync(instance, targetFile, cardSource);
                this.log.info(`Lovelace custom card installed/updated at /${instance}/${targetFile}`);
            }
            for (const yamlFile of yamlFiles) {
                const content = yamlFile.includes('circle') ? yamlSourceCircle : yamlSourceClassic;
                await this.writeFileAsync(instance, yamlFile, content);
            }
            this.log.info(`Lovelace YAML examples freshly installed at /${instance}/${yamlFiles[0]} and /${instance}/${yamlFiles[1]}`);

            await this.setStateAsync('lovelace.cardInstalled', true, true);
            await this.setStateAsync('lovelace.cardPath', statePath, true);
            await this.setStateAsync('lovelace.cardError', '', true);
            if (this.config.restartLovelaceAfterCardInstall) await this.restartLovelaceInstance(instance);
        } catch (error) {
            await this.setStateAsync('lovelace.cardInstalled', false, true);
            await this.setStateAsync('lovelace.cardPath', statePath, true);
            await this.setStateAsync('lovelace.cardError', error.message, true);
            this.log.warn(`Could not install Lovelace custom card: ${error.message}`);
        }
    }

    async cleanupOldVictronLovelaceFiles(instance, keepFiles = []) {
        const keep = new Set(keepFiles);
        const candidates = new Set([
            'cards/victronaddapter-card.js',
            'cards/victronaddapter-flow.js',
            'cards/victronaddapter-flow-circle.js',
            'cards/victronaddapter-flow.yaml',
            'cards/victronaddapter-flow-circle.yaml',
            'cards/victronadapter-flow.js',
            'cards/victronadapter-flow-circle.js',

            'cards/victron-house-control-direct.js',
            'cards/victron-energy-flow-card.js',
            'cards/victron-energy-flow-card-v2.js',
            'cards/victron-energy-flow-card-v3.js',
            'cards/victron-energy-flow-card-v4.js',
            'cards/victron-energy-flow-card-v5.js',
            'cards/victron-energy-flow-card-v6.js',
            'cards/victron-energy-flow-card-v7.js',
            'cards/victron-energy-flow-card-v8.js',
            'cards/victron-energy-flow-card-v9.js',
            'cards/victron-energy-flow-card-v10.js',
            'cards/victron-energy-flow-card-v11.js',
            'cards/victron-energy-flow-card-v12.js',
            'cards/victron-energy-flow-card-v13.js',
            'cards/victron-energy-flow-card-v14.js',
            'cards/victron-energy-flow-card-v15.js',
            'cards/victron-energy-flow-card-v16.js',
            'cards/victron-energy-flow-card-v17.js',
            'cards/victron-energy-flow-card-v18.js',
            'cards/victron-energy-flow-card-v19.js',
            'cards/victron-energy-flow-card-v20.js',
            'cards/victron-energy-flow-card-v21.js',
            'cards/victron-energy-flow-card-v24.js',
            'cards/victron-energy-flow-card-v25.js',
            'cards/victron-energy-flow-card-v28.js',
            'cards/victron-energy-flow-card-v29.js',
            'cards/victron-energy-flow-card-v30.js',
            'cards/victron-energy-flow-card-v31.js',
            'cards/victron-energy-flow-card-v34.js',
            'cards/victron-energy-flow-card-v35.js',
            'cards/victron-energy-flow-card-v36.js',
            'cards/victron-energy-flow-card-v37.js',
            'cards/victron-energy-flow-card-v38.js',
            'cards/victron-energy-flow-card-v39.js',
            'cards/victron-energy-flow-card-v40.js',
            'cards/victron-energy-flow-card-v41.js',
            'cards/lovelace-victron-flow-example.yaml',
            'cards/victron-energy-flow-card.yaml',
            'cards/victron-energy-flow-card-v24.yaml',
            'cards/victron-energy-flow-card-v25.yaml',
            'cards/victron-energy-flow-card-v28.yaml',
            'cards/victron-energy-flow-card-v29.yaml',
            'cards/victron-energy-flow-card-v36.yaml',
            'cards/victron-energy-flow-card-v37.yaml',
            'cards/victron-energy-flow-card-v38.yaml',
            'cards/victron-energy-flow-card-v39.yaml',
            'cards/victron-energy-flow-card-v40.yaml',
            'cards/victron-energy-flow-card-v41.yaml',
            'lovelace-victron-flow-example.yaml',
            'victron-energy-flow-card.yaml'
        ]);

        // Also scan the Lovelace cards directory when the ioBroker file API supports it.
        if (typeof this.readDirAsync === 'function') {
            try {
                const entries = await this.readDirAsync(instance, 'cards');
                for (const entry of entries || []) {
                    const name = String(entry.file || entry.fileName || entry.name || '').trim();
                    if (!name) continue;
                    if (/^victron-energy-flow-card.*\.js$/i.test(name) || /^victron.*\.(ya?ml)$/i.test(name) || /^lovelace-victron.*\.(ya?ml)$/i.test(name)) {
                        candidates.add(`cards/${name}`);
                    }
                }
            } catch (error) {
                this.log.debug(`Could not scan Lovelace cards directory before cleanup: ${error.message}`);
            }
        }

        let removed = 0;
        for (const file of candidates) {
            if (keep.has(file)) continue;
            if (await this.deleteLovelaceFileIfExists(instance, file)) removed++;
        }
        return removed;
    }

    async deleteLovelaceFileIfExists(instance, file) {
        try {
            await this.readFileAsync(instance, file);
        } catch (error) {
            return false;
        }

        const attempts = [
            ['delFileAsync', [instance, file]],
            ['deleteFileAsync', [instance, file]],
            ['unlinkAsync', [instance, file]],
            ['rmAsync', [instance, file]]
        ];
        for (const [method, args] of attempts) {
            if (typeof this[method] !== 'function') continue;
            try {
                await this[method](...args);
                this.log.info(`Removed old Lovelace file /${instance}/${file}`);
                return true;
            } catch (error) {
                this.log.debug(`Delete method ${method} failed for /${instance}/${file}: ${error.message}`);
            }
        }

        // Last resort: overwrite with an empty comment. The new V22/V23 files are written afterwards.
        try {
            await this.writeFileAsync(instance, file, '/* removed by victron-house-control cleanup */\n');
            this.log.warn(`Could not physically delete /${instance}/${file}; replaced it with an empty placeholder.`);
            return true;
        } catch (error) {
            this.log.warn(`Could not delete or overwrite old Lovelace file /${instance}/${file}: ${error.message}`);
            return false;
        }
    }

    fileContentToString(value) {
        if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'file')) {
            value = value.file;
        }
        if (Buffer.isBuffer(value)) return value.toString('utf8');
        if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
        if (value === null || value === undefined) return '';
        return String(value);
    }

    async restartLovelaceInstance(instance) {
        const objectId = `system.adapter.${instance}`;
        try {
            const obj = await this.getForeignObjectAsync(objectId);
            if (!obj || !obj.common || obj.common.enabled === false) {
                this.log.info(`Lovelace instance ${instance} is not enabled; card was installed but no restart was triggered.`);
                return;
            }

            this.log.info(`Restarting ${instance} once so the new Victron custom card is loaded.`);
            await this.extendForeignObjectAsync(objectId, { common: { enabled: false } });
            await this.delay(2500);
            await this.extendForeignObjectAsync(objectId, { common: { enabled: true } });
            await this.setStateAsync('lovelace.lastRestart', new Date().toISOString(), true);
        } catch (error) {
            await this.setStateAsync('lovelace.cardError', `Karte installiert, aber Lovelace-Neustart fehlgeschlagen: ${error.message}`, true);
            this.log.warn(`Lovelace card was installed but ${instance} could not be restarted automatically: ${error.message}`);
        }
    }

    delay(ms) {
        return new Promise(resolve => this.setTimeout(resolve, ms));
    }

    sanitizeLovelaceEntityName(value) {
        return String(value || '')
            .toLowerCase()
            .replace(/ä/g, 'ae')
            .replace(/ö/g, 'oe')
            .replace(/ü/g, 'ue')
            .replace(/ß/g, 'ss')
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .substring(0, 120) || 'victron_value';
    }

    buildLovelaceCustom(objectId, definition, writable) {
        const instance = String(this.config.lovelaceInstance || 'lovelace.0').trim() || 'lovelace.0';
        if (!/^lovelace\.\d+$/.test(instance)) return null;

        // Only expose stable read values as Lovelace sensors automatically. Control states stay in ioBroker
        // until a dedicated control card is added, so no unsafe write points are created in Lovelace.
        if (writable) return null;
        if (!objectId.startsWith('system.') && !objectId.startsWith('flow.') && !objectId.startsWith('dashboard.') && !objectId.startsWith('view.')) return null;

        const commonType = definition.commonType || definition.objectType || definition.type;
        const ioBrokerType = ["string", "number", "boolean", "mixed", "array", "object"].includes(commonType)
            ? commonType
            : (definition.boolean ? 'boolean' : 'number');
        if (!['number', 'string', 'boolean'].includes(ioBrokerType)) return null;

        const name = this.sanitizeLovelaceEntityName(`${this.namespace}_${objectId.replace(/\./g, '_')}`);
        return {
            [instance]: {
                enabled: true,
                entity: ioBrokerType === 'boolean' ? 'binary_sensor' : 'sensor',
                name
            }
        };
    }

    async ensureStateObject(objectId, definition, writable, native = {}) {
        const common = stateCommon(definition, writable);
        const lovelaceCustom = this.buildLovelaceCustom(objectId, definition, writable);
        if (lovelaceCustom) {
            common.custom = lovelaceCustom;
        }

        const nextObject = {
            type: 'state',
            common,
            native
        };
        const existing = await this.getObjectAsync(objectId);
        if (existing) {
            const mergedCommon = {
                ...(existing.common || {}),
                ...nextObject.common
            };
            if ((existing.common && existing.common.custom) || nextObject.common.custom) {
                mergedCommon.custom = {
                    ...((existing.common && existing.common.custom) || {}),
                    ...(nextObject.common.custom || {})
                };
            }

            await this.setObjectAsync(objectId, {
                ...existing,
                type: 'state',
                common: mergedCommon,
                native: {
                    ...(existing.native || {}),
                    ...nextObject.native
                }
            });
        } else {
            await this.setObjectNotExistsAsync(objectId, nextObject);
        }
    }

    async createSystemObjects() {
        for (const definition of SYSTEM_REGISTERS) {
            await this.ensureStateObject(`system.${definition.id}`, definition, false, {
                unitId: this.config.unitIdSystem,
                address: definition.address,
                type: definition.type,
                scale: definition.scale
            });
        }
    }

    async createFlowObjects() {
        for (const definition of FLOW_STATES) {
            await this.ensureStateObject(`flow.${definition.id}`, definition, false, {
                calculated: true
            });
        }
    }

    async createDashboardObjects() {
        await this.ensureChannelObject('dashboard', 'Lovelace Dashboard', 'Synchronisierte Live-Werte für die Lovelace-Energieflusskarten. Die Einzelwerte und die JSON-Momentaufnahme stammen aus demselben Abfragezyklus.');
        await this.ensureStateObject('dashboard.snapshot_json', {
            id: 'snapshot_json',
            name: 'Dashboard Momentaufnahme',
            friendlyName: 'Dashboard Momentaufnahme',
            description: 'JSON-Momentaufnahme für die Victron Lovelace-Karten. Enthält Netz, PV, Batterie, Lasten und Flussrichtung aus einem Polling-Zyklus.',
            commonType: 'string',
            type: 'string',
            role: 'json'
        }, false, { calculated: true, snapshot: true });

        const dashboardStates = [
            ['last_update_ms', 'Dashboard Aktualisierung', 'Zeitpunkt der letzten Dashboard-Momentaufnahme als Unix-Zeit in Millisekunden.', 'number', 'value.time', 'ms'],
            ['grid_total', 'Netzleistung gesamt live', 'Live-Wert für Netzleistung gesamt. Negativ bedeutet Einspeisung, positiv bedeutet Netzbezug.', 'number', 'value.power', 'W'],
            ['grid_l1', 'Netzleistung L1 live', 'Live-Wert Netzleistung Phase L1.', 'number', 'value.power', 'W'],
            ['grid_l2', 'Netzleistung L2 live', 'Live-Wert Netzleistung Phase L2.', 'number', 'value.power', 'W'],
            ['grid_l3', 'Netzleistung L3 live', 'Live-Wert Netzleistung Phase L3.', 'number', 'value.power', 'W'],
            ['grid_flow', 'Netzfluss live', 'Entprellter Live-Wert für die Richtung der Netzfluss-Animation.', 'number', 'value.power', 'W'],
            ['grid_status', 'Netzstatus live', 'Textstatus Netzbezug, Einspeisung oder ausgeglichen.', 'string', 'text', ''],
            ['pv_total', 'PV gesamt live', 'Live-Wert PV-Erzeugung gesamt.', 'number', 'value.power', 'W'],
            ['pv_ac', 'PV AC live', 'Live-Wert PV-Erzeugung über AC-Wechselrichter.', 'number', 'value.power', 'W'],
            ['pv_ac_l1', 'PV AC L1 live', 'Live-Wert PV AC Phase L1.', 'number', 'value.power', 'W'],
            ['pv_ac_l2', 'PV AC L2 live', 'Live-Wert PV AC Phase L2.', 'number', 'value.power', 'W'],
            ['pv_ac_l3', 'PV AC L3 live', 'Live-Wert PV AC Phase L3.', 'number', 'value.power', 'W'],
            ['pv_dc', 'PV DC live', 'Live-Wert PV-Erzeugung über DC-Laderegler.', 'number', 'value.power', 'W'],
            ['house_total', 'Haus gesamt live', 'Live-Wert gesamter Hausverbrauch aus AC-Lasten und essentiellen Lasten.', 'number', 'value.power', 'W'],
            ['ac_loads_total', 'AC-Lasten gesamt live', 'Live-Wert normale AC-Lasten.', 'number', 'value.power', 'W'],
            ['ac_loads_l1', 'AC-Lasten L1 live', 'Live-Wert normale AC-Lasten Phase L1.', 'number', 'value.power', 'W'],
            ['ac_loads_l2', 'AC-Lasten L2 live', 'Live-Wert normale AC-Lasten Phase L2.', 'number', 'value.power', 'W'],
            ['ac_loads_l3', 'AC-Lasten L3 live', 'Live-Wert normale AC-Lasten Phase L3.', 'number', 'value.power', 'W'],
            ['essential_loads_total', 'Essentielle Lasten gesamt live', 'Live-Wert essentielle Lasten am Wechselrichter-/Notstromausgang.', 'number', 'value.power', 'W'],
            ['essential_loads_l1', 'Essentielle Lasten L1 live', 'Live-Wert essentielle Lasten Phase L1.', 'number', 'value.power', 'W'],
            ['essential_loads_l2', 'Essentielle Lasten L2 live', 'Live-Wert essentielle Lasten Phase L2.', 'number', 'value.power', 'W'],
            ['essential_loads_l3', 'Essentielle Lasten L3 live', 'Live-Wert essentielle Lasten Phase L3.', 'number', 'value.power', 'W'],
            ['battery_soc', 'Akku Ladezustand live', 'Live-Wert Batterie-Ladezustand.', 'number', 'value.battery', '%'],
            ['battery_power', 'Akku Leistung live', 'Live-Wert Batterieleistung. Positiv bedeutet Laden, negativ bedeutet Entladen.', 'number', 'value.power', 'W'],
            ['battery_flow', 'Akku Fluss live', 'Entprellter Live-Wert für die Richtung der Batterie-Animation.', 'number', 'value.power', 'W'],
            ['battery_voltage', 'Akku Spannung live', 'Live-Wert Batteriespannung.', 'number', 'value.voltage', 'V'],
            ['battery_current', 'Akku Strom live', 'Live-Wert Batteriestrom.', 'number', 'value.current', 'A'],
            ['battery_temperature', 'Akku Temperatur live', 'Live-Wert Batterietemperatur.', 'number', 'value.temperature', '°C'],
            ['battery_status', 'Akku Status live', 'Textstatus Laden, Entladen oder Standby.', 'string', 'text', ''],
            ['surplus', 'PV Überschuss live', 'Live-Wert verfügbarer PV-Überschuss.', 'number', 'value.power', 'W']
        ];

        for (const [id, name, description, commonType, role, unit] of dashboardStates) {
            await this.ensureStateObject(`dashboard.${id}`, {
                id,
                name,
                friendlyName: name,
                description,
                commonType,
                type: commonType,
                role,
                unit
            }, false, { calculated: true, dashboardScalar: true });
        }
    }


    async createViewObjects() {
        await this.ensureChannelObject('view', 'Live Ansicht', 'Vom Adapter fertig berechnete Anzeige-Werte für Lovelace. Lovelace berechnet hier nichts mehr, sondern zeigt nur noch diese Werte an.');
        await this.ensureStateObject('view.payload_json', {
            id: 'payload_json',
            name: 'Live Ansicht Payload',
            friendlyName: 'Live Ansicht Payload',
            description: 'Fertig berechnetes JSON-Payload für die Lovelace-Ansichten. Wird bei jedem Polling-Zyklus neu geschrieben, damit Lovelace Live-Updates erhält.',
            commonType: 'string',
            type: 'string',
            role: 'json'
        }, false, { calculated: true, viewPayload: true });
        await this.ensureStateObject('view.load_sources_json', {
            id: 'load_sources_json',
            name: 'Lasten Quellen Diagnose',
            friendlyName: 'Lasten Quellen Diagnose',
            description: 'Diagnose der verwendeten Quellen für AC-Lasten und essentielle Lasten inklusive Roh-Phasenwerte.',
            commonType: 'string',
            type: 'string',
            role: 'json'
        }, false, { calculated: true, viewPayload: true });
        await this.ensureStateObject('view.revision', {
            id: 'revision', name: 'Live Ansicht Revision', friendlyName: 'Live Ansicht Revision',
            description: 'Zähler, der bei jedem Polling-Zyklus erhöht wird. Dient Lovelace als Live-Update-Signal.',
            commonType: 'number', type: 'number', role: 'value'
        }, false, { calculated: true, viewPayload: true });
        await this.ensureStateObject('view.last_change_ms', {
            id: 'last_change_ms', name: 'Live Ansicht Änderung', friendlyName: 'Live Ansicht Änderung',
            description: 'Zeitpunkt der letzten Anzeige-Wert-Änderung als Unix-Zeit in Millisekunden.',
            commonType: 'number', type: 'number', role: 'value.time', unit: 'ms'
        }, false, { calculated: true, viewPayload: true });

        const numberStates = [
            ['grid_total', 'Netzleistung gesamt', 'W'], ['grid_l1', 'Netzleistung L1', 'W'], ['grid_l2', 'Netzleistung L2', 'W'], ['grid_l3', 'Netzleistung L3', 'W'], ['grid_flow', 'Netzfluss Richtung', 'W'],
            ['pv_total', 'PV gesamt', 'W'], ['pv_ac', 'PV AC', 'W'], ['pv_ac_l1', 'PV AC L1', 'W'], ['pv_ac_l2', 'PV AC L2', 'W'], ['pv_ac_l3', 'PV AC L3', 'W'], ['pv_dc', 'PV DC', 'W'],
            ['house_total', 'Haus gesamt', 'W'], ['house_l1', 'Haus L1', 'W'], ['house_l2', 'Haus L2', 'W'], ['house_l3', 'Haus L3', 'W'],
            ['ac_loads_total', 'AC-Lasten gesamt', 'W'], ['ac_loads_l1', 'AC-Lasten L1', 'W'], ['ac_loads_l2', 'AC-Lasten L2', 'W'], ['ac_loads_l3', 'AC-Lasten L3', 'W'],
            ['essential_loads_total', 'Essentielle Lasten gesamt', 'W'], ['essential_loads_l1', 'Essentielle Lasten L1', 'W'], ['essential_loads_l2', 'Essentielle Lasten L2', 'W'], ['essential_loads_l3', 'Essentielle Lasten L3', 'W'],
            ['battery_soc', 'Akku Ladezustand', '%'], ['battery_power', 'Akku Leistung', 'W'], ['battery_flow', 'Akku Fluss Richtung', 'W'], ['battery_voltage', 'Akku Spannung', 'V'], ['battery_current', 'Akku Strom', 'A'], ['battery_temperature', 'Akku Temperatur', '°C'],
            ['surplus', 'PV Überschuss', 'W']
        ];
        for (const [id, name, unit] of numberStates) {
            await this.ensureStateObject(`view.${id}`, {
                id, name, friendlyName: name,
                description: `Fertig berechneter Anzeige-Wert: ${name}.`,
                commonType: 'number', type: 'number', role: unit === '%' ? 'value.battery' : unit === 'V' ? 'value.voltage' : unit === 'A' ? 'value.current' : unit === '°C' ? 'value.temperature' : 'value.power', unit
            }, false, { calculated: true, viewPayload: true });
        }
        const textStates = [
            ['grid_status', 'Netzstatus'],
            ['battery_status', 'Akku Status']
        ];
        for (const [id, name] of textStates) {
            await this.ensureStateObject(`view.${id}`, {
                id, name, friendlyName: name,
                description: `Fertig berechneter Anzeige-Text: ${name}.`,
                commonType: 'string', type: 'string', role: 'text'
            }, false, { calculated: true, viewPayload: true });
        }
    }

    async createControlObjects() {
        for (const definition of CONTROL_REGISTERS) {
            if (definition.requiresNewSetpoint && !this.config.useNewSetpoint) continue;
            if (definition.requiresLegacySetpoint && !this.config.legacySetpointEnabled) continue;

            const objectId = `controls.${definition.id}`;
            this.controlByStateId.set(`${this.namespace}.${objectId}`, definition);
            await this.ensureStateObject(objectId, definition, definition.write, {
                unitId: this.config.controlUnitId,
                address: definition.address,
                type: definition.type,
                scale: definition.scale,
                rawScaleForWrite: definition.rawScaleForWrite
            });
        }
    }

    async createRawWriteObjects() {
        await this.ensureChannelObject('raw', 'Rohzugriff Modbus', 'Technischer Testbereich für direkte Modbus-Schreibbefehle. Nur für Diagnose verwenden.');
        await this.ensureChannelObject(this.rawPrefix, 'Direkter Schreibbefehl', 'Direktes Schreiben eines einzelnen Modbus-Registers. Nur mit Vorsicht verwenden.');
        const rawStates = [
            { id: 'unitId', type: 'number', role: 'value', name: 'Ziel Unit-ID', desc: 'Modbus Unit-ID des Zielgeräts.', def: this.config.controlUnitId },
            { id: 'address', type: 'number', role: 'value', name: 'Zielregister', desc: 'Technische Modbus-Registeradresse.', def: 2700 },
            { id: 'value', type: 'number', role: 'value', name: 'Rohwert', desc: 'Unskalierter Registerwert, der geschrieben werden soll.', def: 0 },
            { id: 'execute', type: 'boolean', role: 'button', name: 'Schreibbefehl ausführen', desc: 'Startet den direkten Schreibbefehl.', def: false }
        ];
        for (const state of rawStates) {
            await this.setObjectNotExistsAsync(`${this.rawPrefix}.${state.id}`, {
                type: 'state',
                common: { name: state.name, type: state.type, role: state.role, read: true, write: true, def: state.def, desc: state.desc },
                native: {}
            });
        }
    }

    async pollOnce() {
        if (this.isStopping || this.isPolling || !this.client) return;
        this.isPolling = true;
        let successCount = 0;
        try {
            try {
                await this.client.connect();
            } catch (error) {
                if (this.isStopping) return;
                await this.safeSetStateAsync('info.connection', false, true);
                await this.safeSetStateAsync('status.lastError', `Connection failed to ${this.config.host}:${this.config.port} - ${error.message}`, true);
                this.log.warn(`Connection failed to ${this.config.host}:${this.config.port}: ${error.message}`);
                return;
            }

            if (this.isStopping) return;
            this.lastValues.clear();

            successCount += await this.readDefinitions(this.config.unitIdSystem, SYSTEM_REGISTERS, 'system');
            if (this.isStopping) return;

            const activeControls = CONTROL_REGISTERS.filter(definition => {
                if (definition.requiresNewSetpoint && !this.config.useNewSetpoint) return false;
                if (definition.requiresLegacySetpoint && !this.config.legacySetpointEnabled) return false;
                return true;
            });
            successCount += await this.readDefinitions(this.config.controlUnitId, activeControls, 'controls');
            if (this.isStopping) return;

            for (const device of this.discoveredDevices.values()) {
                if (this.isStopping) return;
                successCount += await this.readDefinitions(device.unitId, device.profile.registers, `devices.unit_${device.unitId}.${device.profile.key}`);
            }

            if (this.isStopping) return;
            await this.updateFlowStates();
            if (this.isStopping) return;

            const connected = successCount > 0;
            await this.safeSetStateAsync('info.connection', connected, true);
            if (connected) {
                await this.safeSetStateAsync('status.lastPoll', new Date().toISOString(), true);
                await this.safeSetStateAsync('status.lastError', '', true);
            } else {
                await this.safeSetStateAsync('status.lastError', 'No Modbus registers could be read', true);
            }
        } catch (error) {
            if (this.isShutdownError(error)) {
                this.log.debug(`Polling stopped during shutdown: ${error.message}`);
                return;
            }
            await this.safeSetStateAsync('info.connection', false, true);
            await this.safeSetStateAsync('status.lastError', error.message, true);
            this.log.warn(`Polling error: ${error.message}`);
        } finally {
            this.isPolling = false;
        }
    }

    async readDefinitions(unitId, definitions, prefix) {
        if (this.isStopping) return 0;
        let count = 0;
        for (const group of this.groupDefinitions(definitions)) {
            if (this.isStopping) break;
            if (group.length === 1) {
                if (await this.readDefinition(unitId, group[0], `${prefix}.${group[0].id}`)) count++;
                continue;
            }
            const groupCount = await this.readDefinitionGroup(unitId, group, prefix);
            count += groupCount;
        }
        return count;
    }

    groupDefinitions(definitions) {
        const sorted = [...definitions].sort((a, b) => a.address - b.address);
        const groups = [];
        let group = [];
        let end = null;
        for (const definition of sorted) {
            const length = getRegisterLength(definition.type);
            if (!group.length || (definition.address === end && (definition.address + length - group[0].address) <= 60)) {
                group.push(definition);
                end = definition.address + length;
            } else {
                groups.push(group);
                group = [definition];
                end = definition.address + length;
            }
        }
        if (group.length) groups.push(group);
        return groups;
    }

    async readDefinitionGroup(unitId, group, prefix) {
        if (this.isStopping) return 0;
        const start = group[0].address;
        const end = group.reduce((max, definition) => Math.max(max, definition.address + getRegisterLength(definition.type)), start);
        const quantity = end - start;
        try {
            const registers = await this.client.readHoldingRegisters(unitId, start, quantity);
            let count = 0;
            for (const definition of group) {
                if (this.isStopping) return count;
                const offset = definition.address - start;
                const length = getRegisterLength(definition.type);
                const slice = registers.slice(offset, offset + length);
                const value = decodeRegisters(slice, definition.type, definition.scale, definition.boolean);
                if (value !== null && value !== undefined) {
                    const objectId = `${prefix}.${definition.id}`;
                    await this.safeSetStateAsync(objectId, value, true);
                    this.lastValues.set(objectId, value);
                    count++;
                }
            }
            return count;
        } catch (error) {
            if (this.isShutdownError(error)) {
                this.log.debug(`Grouped read stopped during shutdown unit=${unitId} address=${start}: ${error.message}`);
                return 0;
            }
            this.log.debug(`Grouped read failed unit=${unitId} address=${start} quantity=${quantity}: ${error.message}`);
            let count = 0;
            for (const definition of group) {
                if (this.isStopping) break;
                if (await this.readDefinition(unitId, definition, `${prefix}.${definition.id}`)) count++;
            }
            return count;
        }
    }

    async readDefinitionGroup(unitId, group, prefix) {
        const start = group[0].address;
        const end = group.reduce((max, definition) => Math.max(max, definition.address + getRegisterLength(definition.type)), start);
        const quantity = end - start;
        try {
            const registers = await this.client.readHoldingRegisters(unitId, start, quantity);
            let count = 0;
            for (const definition of group) {
                const offset = definition.address - start;
                const length = getRegisterLength(definition.type);
                const slice = registers.slice(offset, offset + length);
                const value = decodeRegisters(slice, definition.type, definition.scale, definition.boolean);
                if (value !== null && value !== undefined) {
                    const objectId = `${prefix}.${definition.id}`;
                    await this.setStateAsync(objectId, value, true);
                    this.lastValues.set(objectId, value);
                    count++;
                }
            }
            return count;
        } catch (error) {
            this.log.debug(`Grouped read failed unit=${unitId} address=${start} quantity=${quantity}: ${error.message}`);
            let count = 0;
            for (const definition of group) {
                if (await this.readDefinition(unitId, definition, `${prefix}.${definition.id}`)) count++;
            }
            return count;
        }
    }

    async readDefinition(unitId, definition, objectId) {
        if (this.isStopping) return false;
        try {
            const registers = await this.client.readHoldingRegisters(unitId, definition.address, getRegisterLength(definition.type));
            if (this.isStopping) return false;
            const value = decodeRegisters(registers, definition.type, definition.scale, definition.boolean);
            if (value !== null && value !== undefined) {
                await this.safeSetStateAsync(objectId, value, true);
                this.lastValues.set(objectId, value);
                return true;
            }
        } catch (error) {
            if (this.isShutdownError(error)) {
                this.log.debug(`Read stopped during shutdown unit=${unitId} address=${definition.address}: ${error.message}`);
                return false;
            }
            this.log.debug(`Read failed unit=${unitId} address=${definition.address}: ${error.message}`);
        }
        return false;
    }

    async updateFlowStates() {
        const value = id => this.lastValues.get(`system.${id}`);
        const first = (...ids) => {
            for (const id of ids) {
                const v = value(id);
                if (Number.isFinite(v)) return v;
            }
            return undefined;
        };
        const sum = groups => {
            let total = 0;
            let found = false;
            for (const ids of groups) {
                const v = first(...ids);
                if (Number.isFinite(v)) {
                    total += v;
                    found = true;
                }
            }
            return found ? total : undefined;
        };
        const setFlow = async (id, val) => {
            if (this.isStopping) return;
            if (Number.isFinite(val)) {
                await this.safeSetStateAsync(`flow.${id}`, Number.isInteger(val) ? val : Number(val.toFixed(3)), true);
            } else {
                // Avoid keeping obsolete calculated values in Lovelace after a mapping change.
                await this.safeSetStateAsync(`flow.${id}`, null, true);
            }
        };

        const gridTotal = sum([['grid_l1_32', 'grid_l1'], ['grid_l2_32', 'grid_l2'], ['grid_l3_32', 'grid_l3']]);
        const acConsumptionL1 = first('ac_consumption_l1_32', 'ac_consumption_l1');
        const acConsumptionL2 = first('ac_consumption_l2_32', 'ac_consumption_l2');
        const acConsumptionL3 = first('ac_consumption_l3_32', 'ac_consumption_l3');
        const acConsumptionTotal = sum([['ac_consumption_l1_32', 'ac_consumption_l1'], ['ac_consumption_l2_32', 'ac_consumption_l2'], ['ac_consumption_l3_32', 'ac_consumption_l3']]);

        let criticalL1 = first('consumption_on_output_l1');
        let criticalL2 = first('consumption_on_output_l2');
        let criticalL3 = first('consumption_on_output_l3');
        let nonCriticalL1 = first('consumption_on_input_l1');
        let nonCriticalL2 = first('consumption_on_input_l2');
        let nonCriticalL3 = first('consumption_on_input_l3');

        // Some GX installations do not expose all split load registers consistently in Lovelace.
        // Fall back to the total AC consumption phases for essential loads and derive the other side if possible.
        const deriveRemainder = (total, part) => Number.isFinite(total) && Number.isFinite(part) ? Math.max(0, total - part) : undefined;
        if (!Number.isFinite(criticalL1)) criticalL1 = Number.isFinite(acConsumptionL1) && Number.isFinite(nonCriticalL1) ? Math.max(0, acConsumptionL1 - nonCriticalL1) : acConsumptionL1;
        if (!Number.isFinite(criticalL2)) criticalL2 = Number.isFinite(acConsumptionL2) && Number.isFinite(nonCriticalL2) ? Math.max(0, acConsumptionL2 - nonCriticalL2) : acConsumptionL2;
        if (!Number.isFinite(criticalL3)) criticalL3 = Number.isFinite(acConsumptionL3) && Number.isFinite(nonCriticalL3) ? Math.max(0, acConsumptionL3 - nonCriticalL3) : acConsumptionL3;
        if (!Number.isFinite(nonCriticalL1)) nonCriticalL1 = deriveRemainder(acConsumptionL1, criticalL1);
        if (!Number.isFinite(nonCriticalL2)) nonCriticalL2 = deriveRemainder(acConsumptionL2, criticalL2);
        if (!Number.isFinite(nonCriticalL3)) nonCriticalL3 = deriveRemainder(acConsumptionL3, criticalL3);

        const criticalLoads = [criticalL1, criticalL2, criticalL3].filter(Number.isFinite).reduce((a, b) => a + b, 0);
        const criticalLoadsFound = [criticalL1, criticalL2, criticalL3].some(Number.isFinite);
        const nonCriticalLoads = [nonCriticalL1, nonCriticalL2, nonCriticalL3].filter(Number.isFinite).reduce((a, b) => a + b, 0);
        const nonCriticalLoadsFound = [nonCriticalL1, nonCriticalL2, nonCriticalL3].some(Number.isFinite);
        const pvAcOutput = sum([['pv_ac_output_l1_32', 'pv_ac_output_l1'], ['pv_ac_output_l2_32', 'pv_ac_output_l2'], ['pv_ac_output_l3_32', 'pv_ac_output_l3']]);
        const pvAcGrid = sum([['pv_ac_input_l1_32', 'pv_ac_input_l1'], ['pv_ac_input_l2_32', 'pv_ac_input_l2'], ['pv_ac_input_l3_32', 'pv_ac_input_l3']]);
        const pvAcGenset = sum([['pv_ac_genset_l1_32', 'pv_ac_genset_l1'], ['pv_ac_genset_l2_32', 'pv_ac_genset_l2'], ['pv_ac_genset_l3_32', 'pv_ac_genset_l3']]);
        const gensetTotal = sum([['genset_l1_32', 'genset_l1'], ['genset_l2_32', 'genset_l2'], ['genset_l3_32', 'genset_l3']]);
        const pvDc = first('pv_dc_power');
        const batteryPower = first('battery_power');
        const inverterChargerPower = first('inverter_charger_power');
        const pvAcTotal = [pvAcOutput, pvAcGrid, pvAcGenset].filter(Number.isFinite).reduce((a, b) => a + b, 0);
        const pvAcFound = [pvAcOutput, pvAcGrid, pvAcGenset].some(Number.isFinite);
        const pvTotal = (pvAcFound ? pvAcTotal : 0) + (Number.isFinite(pvDc) ? pvDc : 0);

        await setFlow('grid_total', gridTotal);
        await setFlow('grid_import', Number.isFinite(gridTotal) ? Math.max(0, gridTotal) : undefined);
        await setFlow('grid_export', Number.isFinite(gridTotal) ? Math.max(0, -gridTotal) : undefined);
        await setFlow('available_surplus', Number.isFinite(gridTotal) ? Math.max(0, -gridTotal) : undefined);
        await setFlow('ac_consumption_total', acConsumptionTotal);
        await setFlow('critical_loads_total', criticalLoadsFound ? criticalLoads : undefined);
        await setFlow('critical_loads_l1', criticalL1);
        await setFlow('critical_loads_l2', criticalL2);
        await setFlow('critical_loads_l3', criticalL3);
        await setFlow('non_critical_loads_total', nonCriticalLoadsFound ? nonCriticalLoads : undefined);
        await setFlow('non_critical_loads_l1', nonCriticalL1);
        await setFlow('non_critical_loads_l2', nonCriticalL2);
        await setFlow('non_critical_loads_l3', nonCriticalL3);

        // Adapter-side load split for Lovelace views.
        // 0.3.9: corrected against the user-provided Victron CCGX Modbus TCP register list 3.73.
        // com.victronenergy.system / Unit-ID 100:
        //   /Ac/ConsumptionOnInput/Lx/Power   -> 872/874/876 int32
        //      Remark in Victron sheet: "This is the power shown on the overview in the Loads box".
        //      Therefore this is the value displayed as AC-Lasten in the Lovelace view.
        //   /Ac/ConsumptionOnOutput/Lx/Power  -> 878/880/882 int32
        //      This is output/AC-Out and is displayed as Essentielle Lasten.
        //   /Ac/Consumption/Lx/Power          -> 902/904/906 uint32, fallback 817/818/819 uint16
        //      This is total AC consumption / house total, not a source for splitting AC vs essential.
        const inputL1 = first('consumption_on_input_l1');
        const inputL2 = first('consumption_on_input_l2');
        const inputL3 = first('consumption_on_input_l3');
        const outputL1 = first('consumption_on_output_l1');
        const outputL2 = first('consumption_on_output_l2');
        const outputL3 = first('consumption_on_output_l3');
        const acMapL1 = first('ac_consumption_l1_32', 'ac_consumption_l1');
        const acMapL2 = first('ac_consumption_l2_32', 'ac_consumption_l2');
        const acMapL3 = first('ac_consumption_l3_32', 'ac_consumption_l3');

        const phaseHasAny = arr => arr.some(Number.isFinite);
        const phaseSum = arr => phaseHasAny(arr) ? arr.filter(Number.isFinite).reduce((a, b) => a + b, 0) : undefined;
        const phaseValuesOrUndefined = arr => phaseHasAny(arr) ? arr : [undefined, undefined, undefined];
        const sumPhase = (a, b) => Number.isFinite(a) || Number.isFinite(b) ? (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0) : undefined;

        const inputPhases = phaseValuesOrUndefined([inputL1, inputL2, inputL3]);
        const outputPhases = phaseValuesOrUndefined([outputL1, outputL2, outputL3]);
        const acConsumptionPhases = phaseValuesOrUndefined([acMapL1, acMapL2, acMapL3]);

        const acDisplayPhases = inputPhases;                  // AC-Lasten / Victron Loads box
        const essentialDisplayPhases = outputPhases;          // Essentielle Lasten / AC-Out
        const houseDisplayPhases = phaseHasAny(acConsumptionPhases)
            ? acConsumptionPhases
            : [sumPhase(inputPhases[0], outputPhases[0]), sumPhase(inputPhases[1], outputPhases[1]), sumPhase(inputPhases[2], outputPhases[2])];

        const acLoadSource = phaseHasAny(acDisplayPhases) ? 'consumption_on_input_872_874_876_loads_box' : 'missing';
        const essentialLoadSource = phaseHasAny(essentialDisplayPhases) ? 'consumption_on_output_878_880_882_ac_out' : 'missing';
        const houseLoadSource = phaseHasAny(acConsumptionPhases) ? 'ac_consumption_902_904_906_fallback_817_818_819' : 'derived_from_input_plus_output';

        const displayAcL1 = acDisplayPhases[0];
        const displayAcL2 = acDisplayPhases[1];
        const displayAcL3 = acDisplayPhases[2];
        const displayEssentialL1 = essentialDisplayPhases[0];
        const displayEssentialL2 = essentialDisplayPhases[1];
        const displayEssentialL3 = essentialDisplayPhases[2];
        const displayHouseL1 = houseDisplayPhases[0];
        const displayHouseL2 = houseDisplayPhases[1];
        const displayHouseL3 = houseDisplayPhases[2];
        const displayAcLoads = phaseSum(acDisplayPhases);
        const displayAcFound = phaseHasAny(acDisplayPhases);
        const displayEssentialLoads = phaseSum(essentialDisplayPhases);
        const displayEssentialFound = phaseHasAny(essentialDisplayPhases);
        const displayHouseLoads = phaseSum(houseDisplayPhases);

        this.currentLoadSourceInfo = {
            mapping: 'victron_modbus_register_list_3.73_adapter_0.3.9',
            ac: acLoadSource,
            essential: essentialLoadSource,
            house: houseLoadSource,
            note: 'AC-Lasten use /Ac/ConsumptionOnInput L1-L3 because Victron marks these as the overview Loads box. Essentielle Lasten use /Ac/ConsumptionOnOutput L1-L3. Haus gesamt uses /Ac/Consumption L1-L3.',
            rawInputLoadsBox: [inputL1, inputL2, inputL3],
            rawOutputEssential: [outputL1, outputL2, outputL3],
            rawAcConsumptionHouse: [acMapL1, acMapL2, acMapL3],
            displayAc: acDisplayPhases,
            displayEssential: essentialDisplayPhases,
            displayHouse: houseDisplayPhases,
            registers: {
                acLoads: ['872:int32 L1 /Ac/ConsumptionOnInput/L1/Power', '874:int32 L2 /Ac/ConsumptionOnInput/L2/Power', '876:int32 L3 /Ac/ConsumptionOnInput/L3/Power'],
                essentialLoads: ['878:int32 L1 /Ac/ConsumptionOnOutput/L1/Power', '880:int32 L2 /Ac/ConsumptionOnOutput/L2/Power', '882:int32 L3 /Ac/ConsumptionOnOutput/L3/Power'],
                houseTotal: ['902:uint32 L1 /Ac/Consumption/L1/Power', '904:uint32 L2 /Ac/Consumption/L2/Power', '906:uint32 L3 /Ac/Consumption/L3/Power', 'fallback 817/818/819:uint16']
            }
        };

        await setFlow('ac_loads_total', displayAcFound ? displayAcLoads : undefined);
        await setFlow('ac_loads_l1', displayAcL1);
        await setFlow('ac_loads_l2', displayAcL2);
        await setFlow('ac_loads_l3', displayAcL3);
        await setFlow('essential_loads_total', displayEssentialFound ? displayEssentialLoads : undefined);
        await setFlow('essential_loads_l1', displayEssentialL1);
        await setFlow('essential_loads_l2', displayEssentialL2);
        await setFlow('essential_loads_l3', displayEssentialL3);

        await setFlow('pv_ac_output_total', pvAcOutput);
        await setFlow('pv_ac_grid_total', pvAcGrid);
        await setFlow('pv_ac_genset_total', pvAcGenset);
        await setFlow('pv_ac_total', pvAcFound ? pvAcTotal : undefined);
        await setFlow('pv_dc_total', pvDc);
        await setFlow('pv_total', (pvAcFound || Number.isFinite(pvDc)) ? pvTotal : undefined);
        await setFlow('battery_power', batteryPower);
        await setFlow('battery_charge', Number.isFinite(batteryPower) ? Math.max(0, batteryPower) : undefined);
        await setFlow('battery_discharge', Number.isFinite(batteryPower) ? Math.max(0, -batteryPower) : undefined);
        await setFlow('genset_total', gensetTotal);
        await setFlow('inverter_charger_power', inverterChargerPower);

        if (this.isStopping) return;
        await this.updateDashboardSnapshot({
            gridTotal, gridL1: first('grid_l1_32', 'grid_l1'), gridL2: first('grid_l2_32', 'grid_l2'), gridL3: first('grid_l3_32', 'grid_l3'),
            acConsumptionTotal,
            houseTotal: displayHouseLoads, houseL1: displayHouseL1, houseL2: displayHouseL2, houseL3: displayHouseL3,
            acLoadsL1: displayAcL1, acLoadsL2: displayAcL2, acLoadsL3: displayAcL3,
            essentialL1: displayEssentialL1, essentialL2: displayEssentialL2, essentialL3: displayEssentialL3,
            pvAcTotal: pvAcFound ? pvAcTotal : undefined, pvDc, pvTotal: (pvAcFound || Number.isFinite(pvDc)) ? pvTotal : undefined,
            batteryPower, batteryVoltage: first('battery_voltage'), batteryCurrent: first('battery_current'), batterySoc: first('battery_soc'), batteryTemp: first('battery_temperature'),
            surplus: Number.isFinite(gridTotal) ? Math.max(0, -gridTotal) : undefined,
            inverterState: first('battery_state', 'active_input_source'), inverterChargerPower
        });
    }

    _deviceValuesByUnit(profileKey, candidateIds) {
        const ids = Array.isArray(candidateIds) ? candidateIds : [candidateIds];
        const wanted = new Set(ids.filter(Boolean));
        const values = new Map();
        for (const [key, val] of this.lastValues.entries()) {
            const match = String(key).match(/^devices\.unit_(\d+)\.([^.]+)\.(.+)$/);
            if (!match) continue;
            const [, unit, profile, stateId] = match;
            if (profile !== profileKey || !wanted.has(stateId)) continue;
            if (!Number.isFinite(val)) continue;
            const sortIndex = ids.indexOf(stateId);
            const existing = values.get(unit);
            if (!existing || sortIndex < existing.sortIndex) {
                values.set(unit, { value: val, sortIndex });
            }
        }
        return Array.from(values.values()).map(item => item.value);
    }

    _sumDeviceFirst(profileKey, ...candidateIds) {
        const values = this._deviceValuesByUnit(profileKey, candidateIds);
        if (!values.length) return undefined;
        return values.reduce((sum, val) => sum + val, 0);
    }

    _firstDeviceValue(profileKey, ...candidateIds) {
        const values = this._deviceValuesByUnit(profileKey, candidateIds);
        return values.length ? values[0] : undefined;
    }

    _roundForSnapshot(value) {
        if (!Number.isFinite(value)) return null;
        return Number.isInteger(value) ? value : Number(value.toFixed(3));
    }

    _deadband(value, threshold = 0) {
        if (!Number.isFinite(value)) return null;
        return Math.abs(value) <= threshold ? 0 : value;
    }

    _sumSnapshotValues(...values) {
        const finite = values.filter(Number.isFinite);
        if (!finite.length) return null;
        return finite.reduce((sum, val) => sum + val, 0);
    }

    async updateDashboardSnapshot(base) {
        const pick = (...values) => values.find(Number.isFinite);
        const loadDeadband = 0;

        const pvInvL1 = this._sumDeviceFirst('pvinverter', 'l1_power_1058', 'l1_power');
        const pvInvL2 = this._sumDeviceFirst('pvinverter', 'l2_power_1060', 'l2_power');
        const pvInvL3 = this._sumDeviceFirst('pvinverter', 'l3_power_1062', 'l3_power');
        const pvInvPhaseTotal = this._sumSnapshotValues(pvInvL1, pvInvL2, pvInvL3);
        const pvInvTotal = pick(base.pvAcTotal, this._sumDeviceFirst('pvinverter', 'total_power'), pvInvPhaseTotal);
        const pvDcTotal = pick(base.pvDc, this._sumDeviceFirst('solarcharger', 'pv_power'));
        const pvTotal = this._sumSnapshotValues(pvInvTotal, pvDcTotal);

        const batteryPower = pick(base.batteryPower, this._sumDeviceFirst('battery', 'battery_power', 'battery_power_258'));
        const batteryCurrent = pick(base.batteryCurrent, this._firstDeviceValue('battery', 'current'));
        const batteryVoltage = pick(base.batteryVoltage, this._firstDeviceValue('battery', 'battery_voltage'));
        const batterySoc = pick(base.batterySoc, this._firstDeviceValue('battery', 'soc'));
        const batteryTemp = pick(base.batteryTemp, this._firstDeviceValue('battery', 'battery_temperature'));

        const acL1 = this._deadband(base.acLoadsL1, loadDeadband);
        const acL2 = this._deadband(base.acLoadsL2, loadDeadband);
        const acL3 = this._deadband(base.acLoadsL3, loadDeadband);
        const acTotal = this._sumSnapshotValues(acL1, acL2, acL3);

        const essentialL1 = this._deadband(base.essentialL1, 2);
        const essentialL2 = this._deadband(base.essentialL2, 2);
        const essentialL3 = this._deadband(base.essentialL3, 2);
        const essentialTotal = this._sumSnapshotValues(essentialL1, essentialL2, essentialL3);
        const houseL1 = pick(base.houseL1, this._sumSnapshotValues(acL1, essentialL1));
        const houseL2 = pick(base.houseL2, this._sumSnapshotValues(acL2, essentialL2));
        const houseL3 = pick(base.houseL3, this._sumSnapshotValues(acL3, essentialL3));
        const houseTotal = pick(base.houseTotal, this._sumSnapshotValues(houseL1, houseL2, houseL3), this._sumSnapshotValues(acTotal, essentialTotal));

        const gridTotal = pick(base.gridTotal, this._sumSnapshotValues(base.gridL1, base.gridL2, base.gridL3));
        const gridDeadband = 15;
        const gridFlow = this._deadband(gridTotal, gridDeadband);
        const batteryFlow = this._deadband(batteryPower, 25);
        const snapshot = {
            version: '0.5.3',
            timestamp: new Date().toISOString(),
            timestampMs: Date.now(),
            grid: {
                total: this._roundForSnapshot(gridTotal),
                l1: this._roundForSnapshot(base.gridL1),
                l2: this._roundForSnapshot(base.gridL2),
                l3: this._roundForSnapshot(base.gridL3),
                import: this._roundForSnapshot(Number.isFinite(gridTotal) ? Math.max(0, gridTotal) : null),
                export: this._roundForSnapshot(Number.isFinite(gridTotal) ? Math.max(0, -gridTotal) : null),
                flow: this._roundForSnapshot(gridFlow),
                status: gridFlow < 0 ? 'Einspeisung' : gridFlow > 0 ? 'Netzbezug' : 'Ausgeglichen'
            },
            pv: {
                total: this._roundForSnapshot(pvTotal),
                ac: this._roundForSnapshot(pvInvTotal),
                acL1: this._roundForSnapshot(pvInvL1),
                acL2: this._roundForSnapshot(pvInvL2),
                acL3: this._roundForSnapshot(pvInvL3),
                dc: this._roundForSnapshot(pvDcTotal)
            },
            loads: {
                houseTotal: this._roundForSnapshot(houseTotal),
                houseL1: this._roundForSnapshot(houseL1),
                houseL2: this._roundForSnapshot(houseL2),
                houseL3: this._roundForSnapshot(houseL3),
                ac: {
                    total: this._roundForSnapshot(acTotal),
                    l1: this._roundForSnapshot(acL1),
                    l2: this._roundForSnapshot(acL2),
                    l3: this._roundForSnapshot(acL3)
                },
                essential: {
                    total: this._roundForSnapshot(essentialTotal),
                    l1: this._roundForSnapshot(essentialL1),
                    l2: this._roundForSnapshot(essentialL2),
                    l3: this._roundForSnapshot(essentialL3)
                }
            },
            battery: {
                soc: this._roundForSnapshot(batterySoc),
                power: this._roundForSnapshot(batteryPower),
                voltage: this._roundForSnapshot(batteryVoltage),
                current: this._roundForSnapshot(batteryCurrent),
                temperature: this._roundForSnapshot(batteryTemp),
                flow: this._roundForSnapshot(batteryFlow),
                status: batteryFlow > 0 ? 'Laden' : batteryFlow < 0 ? 'Entladen' : 'Standby'
            },
            inverter: {
                state: this._roundForSnapshot(base.inverterState),
                chargerPower: this._roundForSnapshot(base.inverterChargerPower)
            },
            surplus: this._roundForSnapshot(Number.isFinite(gridTotal) ? Math.max(0, -gridTotal) : base.surplus)
        };

        // Dedicated live view data for Lovelace cards.
        // This is the only source used by V18/V19. It intentionally mirrors the values shown in the
        // dashboard and avoids old fallbacks, discovered device sums, or mixed Lovelace entities.
        snapshot.ui = {
            grid: {
                total: snapshot.grid.total,
                l1: snapshot.grid.l1,
                l2: snapshot.grid.l2,
                l3: snapshot.grid.l3,
                status: snapshot.grid.status,
                flow: snapshot.grid.flow
            },
            pv: {
                total: snapshot.pv.total,
                ac: snapshot.pv.ac,
                acL1: snapshot.pv.acL1,
                acL2: snapshot.pv.acL2,
                acL3: snapshot.pv.acL3,
                dc: snapshot.pv.dc
            },
            loads: {
                ac: {
                    total: snapshot.loads.ac.total,
                    l1: snapshot.loads.ac.l1,
                    l2: snapshot.loads.ac.l2,
                    l3: snapshot.loads.ac.l3
                },
                essential: {
                    total: snapshot.loads.essential.total,
                    l1: snapshot.loads.essential.l1,
                    l2: snapshot.loads.essential.l2,
                    l3: snapshot.loads.essential.l3
                },
                houseTotal: snapshot.loads.houseTotal,
                houseL1: snapshot.loads.houseL1,
                houseL2: snapshot.loads.houseL2,
                houseL3: snapshot.loads.houseL3
            },
            battery: {
                soc: snapshot.battery.soc,
                power: snapshot.battery.power,
                voltage: snapshot.battery.voltage,
                current: snapshot.battery.current,
                temperature: snapshot.battery.temperature,
                flow: snapshot.battery.flow,
                status: snapshot.battery.status
            },
            inverter: snapshot.inverter,
            surplus: snapshot.surplus,
            sources: this.currentLoadSourceInfo || {}
        };

        if (this.isStopping) return;
        await this.updateViewStates(snapshot);
        if (this.isStopping) return;

        const setDashboard = async (id, value) => {
            if (this.isStopping) return;
            if (value === undefined) value = null;
            await this.safeSetStateAsync(`dashboard.${id}`, value, true);
        };

        await setDashboard('grid_total', snapshot.grid.total);
        await setDashboard('grid_l1', snapshot.grid.l1);
        await setDashboard('grid_l2', snapshot.grid.l2);
        await setDashboard('grid_l3', snapshot.grid.l3);
        await setDashboard('grid_flow', snapshot.grid.flow);
        await setDashboard('grid_status', snapshot.grid.status);
        await setDashboard('pv_total', snapshot.pv.total);
        await setDashboard('pv_ac', snapshot.pv.ac);
        await setDashboard('pv_ac_l1', snapshot.pv.acL1);
        await setDashboard('pv_ac_l2', snapshot.pv.acL2);
        await setDashboard('pv_ac_l3', snapshot.pv.acL3);
        await setDashboard('pv_dc', snapshot.pv.dc);
        await setDashboard('house_total', snapshot.loads.houseTotal);
        await setDashboard('ac_loads_total', snapshot.loads.ac.total);
        await setDashboard('ac_loads_l1', snapshot.loads.ac.l1);
        await setDashboard('ac_loads_l2', snapshot.loads.ac.l2);
        await setDashboard('ac_loads_l3', snapshot.loads.ac.l3);
        await setDashboard('essential_loads_total', snapshot.loads.essential.total);
        await setDashboard('essential_loads_l1', snapshot.loads.essential.l1);
        await setDashboard('essential_loads_l2', snapshot.loads.essential.l2);
        await setDashboard('essential_loads_l3', snapshot.loads.essential.l3);
        await setDashboard('battery_soc', snapshot.battery.soc);
        await setDashboard('battery_power', snapshot.battery.power);
        await setDashboard('battery_flow', snapshot.battery.flow);
        await setDashboard('battery_voltage', snapshot.battery.voltage);
        await setDashboard('battery_current', snapshot.battery.current);
        await setDashboard('battery_temperature', snapshot.battery.temperature);
        await setDashboard('battery_status', snapshot.battery.status);
        await setDashboard('surplus', snapshot.surplus);
        await this.safeSetStateAsync('dashboard.snapshot_json', JSON.stringify(snapshot), true);
        // Commit signal for Lovelace live cards. Must be written after all values and snapshot.
        await setDashboard('last_update_ms', snapshot.timestampMs);
    }


    async updateViewStates(snapshot) {
        const ui = snapshot && snapshot.ui ? snapshot.ui : null;
        if (!ui) return;

        // In 0.3.3 this function returned early when the visible values were equal.
        // That is bad for Lovelace custom cards because they only receive a new hass update
        // when an exposed state changes. Therefore 0.3.4 writes a fresh payload on EVERY poll.
        // The load calculation is still done in the adapter; Lovelace only displays this payload.
        this.viewRevision = (this.viewRevision || 0) + 1;

        const valuesOnly = {
            grid: ui.grid || {},
            pv: ui.pv || {},
            loads: ui.loads || {},
            battery: ui.battery || {},
            surplus: ui.surplus,
            sources: ui.sources || {}
        };

        const payload = {
            version: '0.5.3',
            revision: this.viewRevision,
            updatedAt: snapshot.timestamp || new Date().toISOString(),
            updatedMs: Number.isFinite(snapshot.timestampMs) ? snapshot.timestampMs : Date.now(),
            ...valuesOnly
        };

        const setView = async (id, value) => {
            if (this.isStopping) return;
            if (value === undefined) value = null;
            await this.safeSetStateAsync(`view.${id}`, value, true);
        };

        await setView('grid_total', ui.grid && ui.grid.total);
        await setView('grid_l1', ui.grid && ui.grid.l1);
        await setView('grid_l2', ui.grid && ui.grid.l2);
        await setView('grid_l3', ui.grid && ui.grid.l3);
        await setView('grid_flow', ui.grid && ui.grid.flow);
        await setView('grid_status', ui.grid && ui.grid.status);

        await setView('pv_total', ui.pv && ui.pv.total);
        await setView('pv_ac', ui.pv && ui.pv.ac);
        await setView('pv_ac_l1', ui.pv && ui.pv.acL1);
        await setView('pv_ac_l2', ui.pv && ui.pv.acL2);
        await setView('pv_ac_l3', ui.pv && ui.pv.acL3);
        await setView('pv_dc', ui.pv && ui.pv.dc);

        await setView('house_total', ui.loads && ui.loads.houseTotal);
        await setView('house_l1', ui.loads && ui.loads.houseL1);
        await setView('house_l2', ui.loads && ui.loads.houseL2);
        await setView('house_l3', ui.loads && ui.loads.houseL3);
        await setView('ac_loads_total', ui.loads && ui.loads.ac && ui.loads.ac.total);
        await setView('ac_loads_l1', ui.loads && ui.loads.ac && ui.loads.ac.l1);
        await setView('ac_loads_l2', ui.loads && ui.loads.ac && ui.loads.ac.l2);
        await setView('ac_loads_l3', ui.loads && ui.loads.ac && ui.loads.ac.l3);
        await setView('essential_loads_total', ui.loads && ui.loads.essential && ui.loads.essential.total);
        await setView('essential_loads_l1', ui.loads && ui.loads.essential && ui.loads.essential.l1);
        await setView('essential_loads_l2', ui.loads && ui.loads.essential && ui.loads.essential.l2);
        await setView('essential_loads_l3', ui.loads && ui.loads.essential && ui.loads.essential.l3);

        await setView('battery_soc', ui.battery && ui.battery.soc);
        await setView('battery_power', ui.battery && ui.battery.power);
        await setView('battery_flow', ui.battery && ui.battery.flow);
        await setView('battery_voltage', ui.battery && ui.battery.voltage);
        await setView('battery_current', ui.battery && ui.battery.current);
        await setView('battery_temperature', ui.battery && ui.battery.temperature);
        await setView('battery_status', ui.battery && ui.battery.status);
        await setView('surplus', ui.surplus);

        await setView('load_sources_json', JSON.stringify(ui.sources || {}));

        // Write payload_json before revision/last_change_ms. The revision is the final commit signal.
        await setView('payload_json', JSON.stringify(payload));
        await setView('revision', this.viewRevision);
        await setView('last_change_ms', payload.updatedMs);
    }

    async scanDevices() {
        if (this.isStopping || this.isScanning || !this.client) return;
        this.isScanning = true;
        const started = Date.now();
        let checkedUnits = 0;
        try {
            const candidates = this.buildScanCandidates();
            let added = 0;
            this.log.debug(`Device scan started: checking ${candidates.length} Unit-ID(s): ${candidates.join(', ')}`);

            for (const unitId of candidates) {
                if (this.isStopping) break;
                checkedUnits++;
                const unitStarted = Date.now();
                let foundForUnit = 0;
                const errors = [];
                this.log.debug(`Scan Unit-ID ${unitId}: checking profiles`);

                try {
                    for (const profile of DEVICE_PROFILES) {
                        if (this.isStopping) break;
                        const key = `${unitId}.${profile.key}`;
                        if (this.discoveredDevices.has(key)) continue;

                        const result = await this.probeProfile(unitId, profile);
                        if (this.isStopping) break;

                        if (result.detected) {
                            await this.createDeviceProfile(unitId, profile);
                            if (this.isStopping) break;
                            this.discoveredDevices.set(key, { unitId, profile });
                            added++;
                            foundForUnit++;
                            this.log.info(`Detected Victron ${profile.name} at Unit-ID ${unitId}`);
                            continue;
                        }

                        if (result.error) {
                            errors.push(`${profile.key}: ${this.formatScanError(result.error)}`);
                            if (this.isUnitTimeoutError(result.error)) {
                                this.log.debug(`Scan Unit-ID ${unitId}: ${this.formatScanError(result.error)}; continuing with next Unit-ID`);
                                break;
                            }
                        }
                    }
                } catch (error) {
                    if (this.isShutdownError(error)) break;
                    errors.push(`unexpected: ${this.formatScanError(error)}`);
                    this.log.debug(`Scan Unit-ID ${unitId}: unexpected error ${this.formatScanError(error)}; continuing with next Unit-ID`);
                }

                if (this.isStopping) break;
                if (foundForUnit > 0) {
                    this.log.debug(`Scan Unit-ID ${unitId}: finished, detected ${foundForUnit} profile(s) in ${Date.now() - unitStarted} ms`);
                } else if (errors.length > 0) {
                    const uniqueErrors = Array.from(new Set(errors)).slice(0, 4).join('; ');
                    this.log.debug(`Scan Unit-ID ${unitId}: no matching profile detected in ${Date.now() - unitStarted} ms; ${uniqueErrors}`);
                } else {
                    this.log.debug(`Scan Unit-ID ${unitId}: no matching profile detected in ${Date.now() - unitStarted} ms`);
                }
            }

            if (this.isStopping) {
                this.log.debug(`Device scan stopped during shutdown after ${checkedUnits} Unit-ID(s)`);
                return;
            }

            await this.safeSetStateAsync('status.discoveredCount', this.discoveredDevices.size, true);
            if (added > 0) {
                await this.pollOnce();
            }
            this.log.debug(`Device scan finished: checked ${checkedUnits}/${candidates.length} Unit-ID(s), added ${added} profile(s) in ${Date.now() - started} ms`);
        } catch (error) {
            if (this.isShutdownError(error)) {
                this.log.debug(`Device scan stopped during shutdown: ${error.message}`);
                return;
            }
            this.log.warn(`Device scan failed: ${error.message}`);
        } finally {
            this.isScanning = false;
        }
    }

    normalizeUnitIdList(value, extraIds = [], fallback = '100,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247') {
        const ids = new Set();
        const add = entry => {
            const n = Number(String(entry).trim());
            if (Number.isInteger(n) && n >= 0 && n <= 255) ids.add(n);
        };

        for (const entry of String(value || fallback).split(',')) add(entry);
        for (const entry of extraIds || []) add(entry);

        if (!ids.size) {
            for (const entry of String(fallback).split(',')) add(entry);
        }

        return Array.from(ids).sort((a, b) => a - b).join(',');
    }

    parseUnitIdList(value) {
        const ids = new Set();
        for (const entry of String(value || '').split(',')) {
            const n = Number(String(entry).trim());
            if (Number.isInteger(n) && n >= 0 && n <= 255) ids.add(n);
        }
        ids.add(this.config.unitIdSystem);
        ids.add(this.config.controlUnitId);
        return Array.from(ids).filter(id => id >= 0 && id <= 255).sort((a, b) => a - b);
    }

    buildScanCandidates() {
        return this.parseUnitIdList(this.config.scanUnitIds);
    }

    async probeProfile(unitId, profile) {
        if (this.isStopping) return { detected: false, stopped: true };
        try {
            const probe = profile.probe;
            await this.client.readHoldingRegisters(unitId, probe.address, getRegisterLength(probe.type));
            return { detected: true };
        } catch (error) {
            return { detected: false, error };
        }
    }

    async createDeviceProfile(unitId, profile) {
        if (this.isStopping) return;
        const unitChannel = `devices.unit_${unitId}`;
        const profileChannel = `${unitChannel}.${profile.key}`;
        await this.ensureChannelObject(unitChannel, `Victron Gerät Unit-ID ${unitId}`, `Automatisch erkannter Victron-Dienst mit Modbus Unit-ID ${unitId}.`, { unitId });
        if (this.isStopping) return;
        await this.ensureChannelObject(profileChannel, profile.name, `Automatisch erkanntes Victron-Profil: ${profile.name}.`, { unitId, profile: profile.key });
        for (const definition of profile.registers) {
            if (this.isStopping) return;
            await this.ensureStateObject(`${profileChannel}.${definition.id}`, definition, false, {
                unitId,
                address: definition.address,
                type: definition.type,
                scale: definition.scale
            });
        }
    }

    async onStateChange(id, state) {
        if (!state || state.ack) return;

        try {
            const relativeId = id.startsWith(`${this.namespace}.`) ? id.substring(this.namespace.length + 1) : id;
            if (relativeId.startsWith('controls.')) {
                await this.handleControlState(id, state.val);
                return;
            }
            if (relativeId === `${this.rawPrefix}.execute` && state.val === true) {
                await this.handleRawWrite();
                await this.setStateAsync(this.rawPrefix + '.execute', false, true);
            }
        } catch (error) {
            this.log.error(`State change handling failed for ${id}: ${error.message}`);
            await this.setStateAsync('status.lastError', error.message, true);
        }
    }

    async handleControlState(fullId, value) {
        const definition = this.controlByStateId.get(fullId);
        if (!definition || !definition.write) return;

        if (!this.config.allowWrites) {
            this.log.warn(`Write blocked for ${fullId}. Enable writes in adapter settings first.`);
            await this.setStateAsync('status.lastError', 'Write blocked: allowWrites is disabled', true);
            await this.pollOnce();
            return;
        }

        if (definition.id.includes('setpoint') || definition.id.includes('power')) {
            const numeric = Number(value);
            if (Number.isFinite(numeric) && (numeric < this.config.writeSafetyMinW || numeric > this.config.writeSafetyMaxW)) {
                throw new Error(`Write blocked: ${numeric} W is outside safety range ${this.config.writeSafetyMinW}..${this.config.writeSafetyMaxW} W`);
            }
        }

        const registers = encodeValue(value, definition);
        if (registers.length === 1) {
            await this.client.writeSingleRegister(this.config.controlUnitId, definition.address, registers[0]);
        } else {
            await this.client.writeMultipleRegisters(this.config.controlUnitId, definition.address, registers);
        }

        await this.setStateAsync(fullId.substring(this.namespace.length + 1), value, true);
        await this.setStateAsync('status.lastError', '', true);
        this.log.info(`Wrote ${value} to Unit-ID ${this.config.controlUnitId}, register ${definition.address} (${definition.id})`);
    }

    async handleRawWrite() {
        if (!this.config.autoCreateRawWriteObjects) return;
        if (!this.config.allowWrites) {
            this.log.warn('Raw write blocked. Enable writes in adapter settings first.');
            await this.setStateAsync('status.lastError', 'Raw write blocked: allowWrites is disabled', true);
            return;
        }

        const [unitIdState, addressState, valueState] = await Promise.all([
            this.getStateAsync(`${this.rawPrefix}.unitId`),
            this.getStateAsync(`${this.rawPrefix}.address`),
            this.getStateAsync(`${this.rawPrefix}.value`)
        ]);
        const unitId = Number(unitIdState && unitIdState.val);
        const address = Number(addressState && addressState.val);
        const value = Number(valueState && valueState.val);
        if (![unitId, address, value].every(Number.isFinite)) {
            throw new Error('Raw write requires numeric unitId, address and value');
        }
        if (value < 0 || value > 65535) {
            throw new Error('Raw write value must be 0..65535');
        }
        await this.client.writeSingleRegister(unitId, address, value);
        this.log.info(`Raw wrote value ${value} to Unit-ID ${unitId}, register ${address}`);
    }

    onUnload(callback) {
        try {
            this.isStopping = true;
            this.clearTimer('pollTimer');
            this.clearTimer('scanTimer');
            if (this.client) {
                this.client.destroy();
                this.client = null;
            }
            this.log.debug('Adapter unload requested: active polls/scans will stop without further state writes.');
            callback();
        } catch (error) {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new VictronHouseControl(options);
} else {
    new VictronHouseControl();
}
