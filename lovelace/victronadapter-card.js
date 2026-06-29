/*
 * Victron Adapter Lovelace cards
 * Version: 0.6.2
 *
 * This card reads the live values directly from dashboard.* states.
 * No payload_json, no view.*, no fuzzy fallback between AC and Essential.
 */
class VictronAdapterDashboardDirectBase extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
    this._timer = null;
    this._resolved = {};
  }

  static get DEFAULT_VALUES() {
    const d = 'dashboard';
    const p = 'sensor.victronadapter_0_dashboard';
    return {
      last_update_ms: [`${p}_last_update_ms`, `victronadapter.0.${d}.last_update_ms`],
      grid_total: [`${p}_grid_total`, `victronadapter.0.${d}.grid_total`],
      grid_l1: [`${p}_grid_l1`, `victronadapter.0.${d}.grid_l1`],
      grid_l2: [`${p}_grid_l2`, `victronadapter.0.${d}.grid_l2`],
      grid_l3: [`${p}_grid_l3`, `victronadapter.0.${d}.grid_l3`],
      grid_status: [`${p}_grid_status`, `victronadapter.0.${d}.grid_status`],
      pv_total: [`${p}_pv_total`, `victronadapter.0.${d}.pv_total`],
      pv_ac: [`${p}_pv_ac`, `victronadapter.0.${d}.pv_ac`],
      pv_ac_l1: [`${p}_pv_ac_l1`, `victronadapter.0.${d}.pv_ac_l1`],
      pv_ac_l2: [`${p}_pv_ac_l2`, `victronadapter.0.${d}.pv_ac_l2`],
      pv_ac_l3: [`${p}_pv_ac_l3`, `victronadapter.0.${d}.pv_ac_l3`],
      pv_dc: [`${p}_pv_dc`, `victronadapter.0.${d}.pv_dc`],
      house_total: [`${p}_house_total`, `victronadapter.0.${d}.house_total`],

      // HARD SEPARATION:
      // AC-Lasten only read dashboard.ac_loads_*
      ac_loads_total: [`${p}_ac_loads_total`, `victronadapter.0.${d}.ac_loads_total`],
      ac_loads_l1: [`${p}_ac_loads_l1`, `victronadapter.0.${d}.ac_loads_l1`],
      ac_loads_l2: [`${p}_ac_loads_l2`, `victronadapter.0.${d}.ac_loads_l2`],
      ac_loads_l3: [`${p}_ac_loads_l3`, `victronadapter.0.${d}.ac_loads_l3`],

      // Essentielle Lasten only read dashboard.essential_loads_*
      essential_loads_total: [`${p}_essential_loads_total`, `victronadapter.0.${d}.essential_loads_total`],
      essential_loads_l1: [`${p}_essential_loads_l1`, `victronadapter.0.${d}.essential_loads_l1`],
      essential_loads_l2: [`${p}_essential_loads_l2`, `victronadapter.0.${d}.essential_loads_l2`],
      essential_loads_l3: [`${p}_essential_loads_l3`, `victronadapter.0.${d}.essential_loads_l3`],

      battery_soc: [`${p}_battery_soc`, `victronadapter.0.${d}.battery_soc`],
      battery_power: [`${p}_battery_power`, `victronadapter.0.${d}.battery_power`],
      battery_voltage: [`${p}_battery_voltage`, `victronadapter.0.${d}.battery_voltage`],
      battery_current: [`${p}_battery_current`, `victronadapter.0.${d}.battery_current`],
      battery_temperature: [`${p}_battery_temperature`, `victronadapter.0.${d}.battery_temperature`],
      battery_status: [`${p}_battery_status`, `victronadapter.0.${d}.battery_status`],
      surplus: [`${p}_surplus`, `victronadapter.0.${d}.surplus`]
    };
  }

  static getStubConfig() {
    return {
      type: 'custom:victronadapter-flow',
      title: 'Energiefluss',
      subtitle: 'Victron Haussteuerung',
      show_details: true,
      show_debug: false,
      values: VictronAdapterDashboardDirectBase.DEFAULT_VALUES
    };
  }

  setConfig(config) {
    this._config = Object.assign({
      title: 'Energiefluss',
      subtitle: 'Victron Haussteuerung',
      show_details: true,
      show_debug: false,
      transparent_background: true,
      decimals: 0,
      values: {}
    }, config || {});
    this._resolved = {};
    this._requestRender();
  }

  set hass(hass) {
    this._hass = hass;
    this._requestRender();
  }

  connectedCallback() { this._requestRender(); }
  disconnectedCallback() {
    if (this._timer) window.clearTimeout(this._timer);
    this._timer = null;
  }
  getCardSize() { return 6; }

  _requestRender() {
    if (this._timer) window.clearTimeout(this._timer);
    this._timer = window.setTimeout(() => {
      this._timer = null;
      this._renderNow();
    }, 0);
  }

  _normalize(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  _candidateList(value) {
    const rawList = Array.isArray(value) ? value : [value];
    const out = [];
    for (const rawValue of rawList) {
      const raw = String(rawValue || '').trim();
      if (!raw) continue;
      out.push(raw);
      if (!raw.startsWith('sensor.')) {
        const norm = this._normalize(raw);
        out.push(`sensor.${norm}`);
        out.push(`sensor.${norm.replace(/^victron_house_control_0_/, 'victron_house_control_')}`);
      }
    }
    return [...new Set(out)];
  }

  _configured(key) {
    const values = this._config.values || {};
    return values[key] ?? VictronAdapterDashboardDirectBase.DEFAULT_VALUES[key];
  }

  _state(key) {
    if (!this._hass || !this._hass.states) return null;
    const candidates = this._candidateList(this._configured(key));
    for (const entityId of candidates) {
      if (this._hass.states[entityId]) {
        this._resolved[key] = entityId;
        return this._hass.states[entityId];
      }
    }
    this._resolved[key] = `NICHT GEFUNDEN: ${candidates.join(' | ')}`;
    return null;
  }

  _raw(key) {
    const state = this._state(key);
    return state ? state.state : undefined;
  }

  _num(key) {
    const raw = this._raw(key);
    if (raw === undefined || raw === null || raw === '' || raw === 'unknown' || raw === 'unavailable') return null;
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    const match = String(raw).replace(',', '.').match(/[-+]?\d+(?:\.\d+)?/);
    if (!match) return null;
    const n = Number(match[0]);
    return Number.isFinite(n) ? n : null;
  }

  _text(key, fallback = '') {
    const raw = this._raw(key);
    if (raw === undefined || raw === null || raw === '' || raw === 'unknown' || raw === 'unavailable') return fallback;
    return String(raw);
  }

  _sum(...values) {
    const nums = values.filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
    if (!nums.length) return null;
    return nums.reduce((a, b) => a + b, 0);
  }

  _values() {
    const grid = this._num('grid_total');
    const batteryPower = this._num('battery_power');
    const acL1 = this._num('ac_loads_l1');
    const acL2 = this._num('ac_loads_l2');
    const acL3 = this._num('ac_loads_l3');
    const essL1 = this._num('essential_loads_l1');
    const essL2 = this._num('essential_loads_l2');
    const essL3 = this._num('essential_loads_l3');

    let acTotal = this._num('ac_loads_total');
    let essTotal = this._num('essential_loads_total');
    if (acTotal === null) acTotal = this._sum(acL1, acL2, acL3);
    if (essTotal === null) essTotal = this._sum(essL1, essL2, essL3);

    return {
      lastUpdateMs: this._num('last_update_ms'),
      grid,
      gridL1: this._num('grid_l1'),
      gridL2: this._num('grid_l2'),
      gridL3: this._num('grid_l3'),
      gridStatus: this._text('grid_status', grid < 0 ? 'Einspeisung' : grid > 0 ? 'Netzbezug' : 'Ausgeglichen'),
      pvTotal: this._num('pv_total'),
      pvAc: this._num('pv_ac'),
      pvAcL1: this._num('pv_ac_l1'),
      pvAcL2: this._num('pv_ac_l2'),
      pvAcL3: this._num('pv_ac_l3'),
      pvDc: this._num('pv_dc'),
      houseTotal: this._num('house_total'),
      acTotal, acL1, acL2, acL3,
      essTotal, essL1, essL2, essL3,
      batterySoc: this._num('battery_soc'),
      batteryPower,
      batteryVoltage: this._num('battery_voltage'),
      batteryCurrent: this._num('battery_current'),
      batteryTemp: this._num('battery_temperature'),
      batteryStatus: this._text('battery_status', batteryPower > 0 ? 'Laden' : batteryPower < 0 ? 'Entladen' : 'Standby'),
      surplus: this._num('surplus')
    };
  }

  _fmtPower(value, signed = false) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    const n = Number(value);
    const sign = signed && n > 0 ? '+' : '';
    const abs = Math.abs(n);
    if (abs >= 10000) return `${sign}${(n / 1000).toFixed(1).replace('.', ',')} kW`;
    if (abs >= 1000) return `${sign}${(n / 1000).toFixed(2).replace('.', ',')} kW`;
    return `${sign}${n.toFixed(this._config.decimals ?? 0).replace('.', ',')} W`;
  }
  _fmtAbsPower(value) { return value === null || value === undefined ? '—' : this._fmtPower(Math.abs(Number(value))); }
  _fmtPercent(value) { return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toFixed(0).replace('.', ',')}%`; }
  _fmtVoltage(value) { return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toFixed(2).replace('.', ',')} V`; }
  _fmtCurrent(value) { return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toFixed(1).replace('.', ',')} A`; }

  _timeText(v) {
    const ts = v && Number.isFinite(Number(v.lastUpdateMs)) ? Number(v.lastUpdateMs) : null;
    if (!ts) return '';
    try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { return ''; }
  }

  _baseStyles() {
    return `
      :host{display:block;--vhc-blue:#2f9cff;--vhc-text:#f4f8ff;--vhc-muted:rgba(234,243,255,.68)}
      ha-card{border-radius:16px;overflow:hidden;color:var(--vhc-text)}
      .wrap{position:relative;padding:18px;background:radial-gradient(circle at 50% 42%,rgba(18,62,96,.18),rgba(0,0,0,.88) 74%)}
      .head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:14px}
      h3{margin:0;font-size:18px;font-weight:850} h3 small{display:block;margin-top:5px;font-size:12px;color:var(--vhc-muted);font-weight:500}
      .live{font-size:11px;color:var(--vhc-muted);white-space:nowrap}
      .box{border:3px solid var(--vhc-blue);border-radius:14px;background:linear-gradient(180deg,rgba(12,58,94,.96),rgba(10,44,72,.97));padding:22px 28px;box-shadow:0 0 16px rgba(47,156,255,.22);box-sizing:border-box}
      .box .title{font-size:26px;font-weight:500;display:flex;gap:14px;align-items:center}
      .box .main{font-size:54px;font-weight:850;margin:14px 0 22px}
      .box .sub{font-size:22px;color:var(--vhc-muted);margin-top:-4px;margin-bottom:18px}
      .phases div,.kv{display:flex;justify-content:space-between;gap:18px;font-size:24px;line-height:1.35}
      .phases span,.kv span{color:var(--vhc-muted)} .phases b,.kv b{font-weight:850}
      .footer{margin:18px -28px -22px;padding:18px 28px;background:rgba(58,146,214,.92);font-size:28px}
      .footer.charge{background:rgba(45,145,88,.92)}
      .debug{margin-top:14px;font-size:12px;line-height:1.35;color:#d9e7ff;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:10px;white-space:pre-wrap;overflow:auto}
      @media(max-width:760px){.wrap{padding:14px}.box{padding:20px 28px}.box .title{font-size:24px}.box .main{font-size:50px}.box .sub{font-size:21px}.phases div,.kv{font-size:22px}.footer{font-size:25px}}
    `;
  }

  _phaseRows(rows) {
    return `<div class="phases">${rows.map(([label, value]) => `<div><span>${label}</span><b>${this._fmtPower(value)}</b></div>`).join('')}</div>`;
  }


  _flowInfo(v) {
    const grid = Number(v.grid) || 0;
    const batt = Number(v.batteryPower) || 0;
    const pv = Number(v.pvTotal) || 0;
    const ac = Number(v.acTotal) || 0;
    const ess = Number(v.essTotal) || 0;

    return {
      pv: pv > 5 ? 'PV → Anlage' : 'PV inaktiv',
      ac: ac > 5 ? 'Anlage → AC-Lasten' : 'AC-Lasten 0 W',
      ess: ess > 5 ? 'Anlage → Essentielle Lasten' : 'Essentielle Lasten 0 W',
      grid: Math.abs(grid) < 15 ? 'Netz Standby' : grid > 0 ? 'Netz → Anlage' : 'Anlage → Netz',
      batt: Math.abs(batt) < 25 ? 'Akku Standby' : batt > 0 ? 'Anlage → Akku' : 'Akku → Anlage'
    };
  }

  _debugHtml(v) {
    if (!this._config.show_debug) return '';
    const keys = ['ac_loads_total','ac_loads_l1','ac_loads_l2','ac_loads_l3','essential_loads_total','essential_loads_l1','essential_loads_l2','essential_loads_l3'];
    return `<div class="debug">${keys.map(k => `${k} => ${this._resolved[k] || '?'} => ${this._raw(k) ?? '—'}`).join('\n')}</div>`;
  }

  _renderNoData() {
    this.shadowRoot.innerHTML = `<style>${this._baseStyles()}</style><ha-card><div class="wrap"><div class="box"><div class="title">Keine Livewerte</div><div class="sub">dashboard.* Sensoren nicht gefunden</div>${this._debugHtml({})}</div></div></ha-card>`;
  }

  _renderNow() {}
}

class VictronAdapterFlowCard extends VictronAdapterDashboardDirectBase {
  _renderNow() {
    const v = this._values();
    if (!v) return this._renderNoData();
    const battFooter = [this._fmtVoltage(v.batteryVoltage), this._fmtCurrent(v.batteryCurrent), this._fmtPower(v.batteryPower, true)].filter(x => x !== '—').join(' · ');
    this.shadowRoot.innerHTML = `
      <style>${this._baseStyles()}
        .grid{display:grid;grid-template-columns:1fr;gap:22px}
        @media(min-width:900px){.grid{grid-template-columns:1fr 1fr 1fr}.wide{grid-column:span 2}}
      </style>
      <ha-card><div class="wrap"><div class="head"><h3>${this._config.title || 'Energiefluss'}<small>${this._config.subtitle || 'Victron Haussteuerung'}</small></h3><div class="live">Live ${this._timeText(v)}</div></div>
      <div class="grid">
        <section class="box"><div class="title">⚡ Netz</div><div class="main">${this._fmtAbsPower(v.grid)}</div><div class="sub">${v.gridStatus}</div>${this._phaseRows([['L1', v.gridL1], ['L2', v.gridL2], ['L3', v.gridL3]])}</section>
        <section class="box"><div class="title">☀ Solarertrag</div><div class="main">${this._fmtPower(v.pvTotal)}</div><div class="sub">Erzeugung</div><div class="kv"><span>PV AC</span><b>${this._fmtPower(v.pvAc)}</b></div><div class="kv"><span>PV DC</span><b>${this._fmtPower(v.pvDc)}</b></div></section>
        <section class="box"><div class="title">▣ Batterie</div><div class="main">${this._fmtPercent(v.batterySoc)}</div><div class="sub">${v.batteryStatus}</div><div class="footer ${v.batteryPower > 0 ? 'charge' : ''}">${battFooter}</div></section>
        <section class="box"><div class="title">➜ PV-Überschuss</div><div class="main" style="color:#78e27a">${this._fmtPower(v.surplus, true)}</div></section>
        <section class="box"><div class="title">∿ AC-Lasten</div><div class="main">${this._fmtPower(v.acTotal)}</div>${this._phaseRows([['L1', v.acL1], ['L2', v.acL2], ['L3', v.acL3]])}</section>
        <section class="box"><div class="title">⊙ Essentielle Lasten</div><div class="main">${this._fmtPower(v.essTotal)}</div>${this._phaseRows([['L1', v.essL1], ['L2', v.essL2], ['L3', v.essL3]])}</section>
      </div>${this._debugHtml(v)}</div></ha-card>`;
  }
}

class VictronAdapterFlowCircleCard extends VictronAdapterDashboardDirectBase {
  _renderNow() {
    const v = this._values();
    if (!v) return this._renderNoData();

    const battFooter = [this._fmtVoltage(v.batteryVoltage), this._fmtCurrent(v.batteryCurrent)].filter(x => x !== '—').join(' · ');
    const grid = Number(v.grid) || 0;
    const batt = Number(v.batteryPower) || 0;
    const pv = Number(v.pvTotal) || 0;
    const ac = Number(v.acTotal) || 0;
    const ess = Number(v.essTotal) || 0;
    const flow = this._flowInfo(v);

    const pvIdle = pv > 5 ? '' : ' idle';
    const acIdle = ac > 5 ? '' : ' idle';
    const essIdle = ess > 5 ? '' : ' idle';
    const gridClass = Math.abs(grid) < 15 ? ' idle' : grid < 0 ? ' reverse' : '';
    const battClass = Math.abs(batt) < 25 ? ' idle' : batt < 0 ? ' reverse' : '';

    this.shadowRoot.innerHTML = `
      <style>${this._baseStyles()}
        ha-card{background:${this._config.transparent_background === false ? 'var(--ha-card-background,var(--card-background-color,rgba(20,25,32,.20)))' : 'transparent'}}
        .circle-wrap{position:relative;min-height:690px;max-width:900px;margin:0 auto;overflow:hidden;border-radius:18px}
        .circle-bg{position:absolute;left:50%;top:51%;width:390px;height:390px;transform:translate(-50%,-50%);border-radius:50%;border:2px dashed rgba(255,255,255,.18);box-shadow:0 0 60px rgba(90,140,255,.10) inset;z-index:0}
        .node{position:absolute;width:176px;height:176px;border-radius:50%;border:4px solid currentColor;background:radial-gradient(circle at 35% 25%,rgba(255,255,255,.16),rgba(20,24,31,.30) 68%);display:flex;align-items:center;justify-content:center;text-align:center;box-sizing:border-box;padding:18px;z-index:5;box-shadow:0 0 22px currentColor}
        .node .title{font-weight:800;font-size:16px}.node .main{font-size:25px;font-weight:900;margin-top:7px}.node .sub{font-size:12px;color:var(--vhc-muted);margin-top:3px}.node .footer{font-size:11px;margin-top:4px;color:var(--vhc-muted)}
        .node .phases{margin-top:6px}.node .phases div{font-size:11px;line-height:1.35}
        .pv{left:50%;top:4%;transform:translateX(-50%);color:#71e56f}.gridnode{left:3%;top:50%;transform:translateY(-50%);color:#e2e2e5}.acnode{right:3%;top:28%;color:#ff5f6d}.essential{right:3%;bottom:9%;color:#ffad42}.batt{left:50%;bottom:3%;transform:translateX(-50%);color:#42b7ff}
        .hub{position:absolute;left:50%;top:51%;transform:translate(-50%,-50%);width:142px;height:142px;border-radius:50%;background:radial-gradient(circle at 40% 30%,rgba(120,170,255,.96),rgba(33,64,116,.96));border:4px solid rgba(255,255,255,.62);display:flex;align-items:center;justify-content:center;font-size:42px;font-weight:900;z-index:7;box-shadow:0 0 30px rgba(100,160,255,.45)}
        .hub small{position:absolute;bottom:16px;font-size:11px;font-weight:700;color:#fff}.hub:after{content:'';position:absolute;left:33px;right:33px;bottom:39px;height:5px;border-radius:6px;background:#ff8c2d}
        .flow{position:absolute;height:8px;border-radius:999px;background:linear-gradient(90deg,transparent,currentColor,transparent);z-index:2;color:white;opacity:.88;transform-origin:left center}
        .flow:before,.flow:after{content:'';position:absolute;top:50%;left:0;width:13px;height:13px;margin-top:-6.5px;border-radius:50%;background:currentColor;box-shadow:0 0 12px currentColor;animation:vhcFlow 2.2s linear infinite}
        .flow:after{animation-delay:1.1s}.flow.reverse:before,.flow.reverse:after{animation-direction:reverse}
        .flow.idle{opacity:.16;background:currentColor;box-shadow:none}.flow.idle:before,.flow.idle:after{display:none}
        @keyframes vhcFlow{0%{left:0;opacity:0}12%{opacity:1}88%{opacity:1}100%{left:calc(100% - 13px);opacity:0}}
        .f-pv{left:50%;top:29%;width:180px;transform:translateX(-50%) rotate(90deg);color:#71e56f}
        .f-grid{left:20%;top:51%;width:235px;transform:rotate(0deg);color:#e2e2e5}
        .f-ac{left:55%;top:41%;width:215px;transform:rotate(-25deg);color:#ff5f6d}
        .f-ess{left:55%;top:61%;width:225px;transform:rotate(27deg);color:#ffad42}
        .f-batt{left:50%;top:67%;width:170px;transform:translateX(-50%) rotate(90deg);color:#42b7ff}
        .flow-label{position:absolute;z-index:8;background:rgba(10,14,24,.74);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:6px 10px;font-size:12px;font-weight:750;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.20)}
        .fl-pv{left:50%;top:25%;transform:translateX(-50%);color:#71e56f}.fl-grid{left:31%;top:46%;transform:translateX(-50%);color:#e2e2e5}.fl-ac{right:24%;top:39%;color:#ff5f6d}.fl-ess{right:22%;top:59%;color:#ffad42}.fl-batt{left:50%;bottom:24%;transform:translateX(-50%);color:#42b7ff}
        .legend{position:absolute;left:50%;top:calc(51% + 94px);transform:translateX(-50%);z-index:9;background:rgba(15,20,30,.46);border-radius:14px;padding:10px 13px;min-width:260px;border:1px solid rgba(255,255,255,.15);font-size:12px;backdrop-filter:blur(8px)}
        .legend div{display:flex;justify-content:space-between;gap:16px;line-height:1.55}.legend span{color:var(--vhc-muted)}.legend b{font-weight:850}
        @media(max-width:760px){
          .circle-wrap{min-height:740px}.circle-bg{width:300px;height:300px}.node{width:138px;height:138px;padding:12px}.node .title{font-size:13px}.node .main{font-size:20px}.node .sub,.node .footer,.node .phases div{font-size:10px}.hub{width:102px;height:102px;font-size:32px}.hub:after{left:24px;right:24px;bottom:29px}.hub small{bottom:8px;font-size:10px}
          .pv{top:2%}.gridnode{left:0}.acnode{right:0;top:27%}.essential{right:0;bottom:10%}.batt{bottom:2%}
          .f-pv{top:25%;width:150px}.f-grid{left:20%;top:51%;width:185px}.f-ac{left:55%;top:41%;width:165px}.f-ess{left:55%;top:61%;width:170px}.f-batt{top:69%;width:145px}
          .flow-label{font-size:10px;padding:5px 7px}.fl-grid{left:30%;top:45%}.fl-ac{right:16%;top:39%}.fl-ess{right:12%;top:59%}.fl-batt{bottom:21%}.legend{top:calc(51% + 72px);min-width:225px;font-size:11px}
        }
      </style>
      <ha-card><div class="wrap">
        <div class="head"><h3>${this._config.title || 'Energiefluss'}<small>${this._config.subtitle || 'Victron Adapter Kreis'} · Richtung aus dashboard.*</small></h3><div class="live">Live ${this._timeText(v)}</div></div>
        <div class="circle-wrap">
          <div class="circle-bg"></div>
          <div class="flow f-pv${pvIdle}" title="${flow.pv}"></div>
          <div class="flow f-grid${gridClass}" title="${flow.grid}"></div>
          <div class="flow f-ac${acIdle}" title="${flow.ac}"></div>
          <div class="flow f-ess${essIdle}" title="${flow.ess}"></div>
          <div class="flow f-batt${battClass}" title="${flow.batt}"></div>

          <div class="flow-label fl-pv">${flow.pv}</div>
          <div class="flow-label fl-grid">${flow.grid}</div>
          <div class="flow-label fl-ac">${flow.ac}</div>
          <div class="flow-label fl-ess">${flow.ess}</div>
          <div class="flow-label fl-batt">${flow.batt}</div>

          <section class="node pv"><div><div class="title">PV</div><div class="main">${this._fmtPower(v.pvTotal)}</div><div class="sub">AC ${this._fmtPower(v.pvAc)} · DC ${this._fmtPower(v.pvDc)}</div></div></section>
          <section class="node gridnode"><div><div class="title">Netz</div><div class="main">${this._fmtAbsPower(v.grid)}</div><div class="sub">${v.gridStatus}</div>${this._phaseRows([['L1', v.gridL1], ['L2', v.gridL2], ['L3', v.gridL3]])}</div></section>
          <section class="node acnode"><div><div class="title">AC-Lasten</div><div class="main">${this._fmtPower(v.acTotal)}</div><div class="sub">dashboard.ac_loads_*</div>${this._phaseRows([['L1', v.acL1], ['L2', v.acL2], ['L3', v.acL3]])}</div></section>
          <section class="node essential"><div><div class="title">Essentiell</div><div class="main">${this._fmtPower(v.essTotal)}</div><div class="sub">dashboard.essential_loads_*</div>${this._phaseRows([['L1', v.essL1], ['L2', v.essL2], ['L3', v.essL3]])}</div></section>
          <section class="node batt"><div><div class="title">Akku</div><div class="main">${this._fmtAbsPower(v.batteryPower)}</div><div class="sub">${this._fmtPercent(v.batterySoc)} · ${v.batteryStatus}</div><div class="footer">${battFooter}</div></div></section>
          <div class="hub">∿<small>Anlage</small></div>
          <div class="legend">
            <div><span>PV</span><b>${this._fmtPower(v.pvTotal)}</b></div>
            <div><span>Netz</span><b>${this._fmtPower(v.grid, true)}</b></div>
            <div><span>Akku</span><b>${this._fmtPower(v.batteryPower, true)}</b></div>
            <div><span>AC</span><b>${this._fmtPower(v.acTotal)}</b></div>
            <div><span>Essentiell</span><b>${this._fmtPower(v.essTotal)}</b></div>
          </div>
        </div>
        ${this._debugHtml(v)}
      </div></ha-card>`;
  }
}
if (!customElements.get('victronadapter-flow')) customElements.define('victronadapter-flow', VictronAdapterFlowCard);
if (!customElements.get('victronadapter-flow-circle')) customElements.define('victronadapter-flow-circle', VictronAdapterFlowCircleCard);

window.customCards = window.customCards || [];
for (const card of [
  { type: 'victronadapter-flow', name: 'Victron Adapter Energiefluss', description: 'Liest direkt dashboard.* Werte. AC und Essential sind hart getrennt.', preview: true },
  { type: 'victronadapter-flow-circle', name: 'Victron Adapter Kreis mit Stromrichtung', description: 'Kreis-Ansicht mit animierten Richtungsflüssen aus dashboard.* Werten.', preview: true }
]) {
  if (!window.customCards.some(existing => existing && existing.type === card.type)) {
    window.customCards.push(card);
  }
}
