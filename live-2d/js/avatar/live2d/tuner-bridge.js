'use strict';

const crypto = require('crypto');
const { buildLive2DParameterCatalog } = require('./expression/semantic-actions');
const INPUT_IDS = new Set(['PositionX', 'PositionY', 'PositionZ', 'LeanInput']);

class Live2DTunerBridge {
    constructor(model, { fetchImpl, now = () => performance.now(), log = () => {} } = {}) {
        this.model = model;
        this.fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
        this.now = now;
        this.log = log;
        this.catalog = buildLive2DParameterCatalog(model, model.internalModel.coreModel);
        this.session = crypto.randomUUID();
        this.state = {};
        this.frame = 0;
        this.lastPush = -Infinity;
        this.lastCatalog = -Infinity;
        this.controllers = new Set();
        this.active = false;
        this.connected = false;
    }

    start() {
        this.active = true;
        this.poll();
        this.timer = setInterval(() => this.poll(), 700);
    }

    async request(route, options = {}) {
        const controller = new AbortController();
        this.controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), 1500);
        try {
            const response = await this.fetch(`http://127.0.0.1:1010${route}`, { ...options, signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } finally {
            clearTimeout(timer);
            this.controllers.delete(controller);
        }
    }

    async poll() {
        if (!this.active || this.polling) return;
        this.polling = true;
        try {
            const state = await this.request('/api/params');
            if (this.active) this.state = state;
        } catch (_) { /* Keep valid settings during a short panel restart. */ }
        finally { this.polling = false; }
    }

    applyManual(core, inputsOnly = false) {
        for (const [id, raw] of Object.entries(this.state.manual || {})) {
            const info = this.catalog.get(id);
            if (!info || (inputsOnly && !INPUT_IDS.has(id)) || typeof raw !== 'number' || !Number.isFinite(raw)) continue;
            core.setParameterValueByIndex(info.index, Math.max(info.minimum, Math.min(info.maximum, raw)));
        }
    }

    beforeRender(core) {
        if (!this.active) return;
        // Physics and expression drivers have finished; manual values must win here.
        this.applyManual(core);
        const now = this.now();
        if (this.pushing || now - this.lastPush < 100) return;
        this.lastPush = now;
        const values = {};
        for (const info of this.catalog.values()) {
            const value = core.getParameterValueByIndex(info.index);
            if (Number.isFinite(value)) values[info.id] = value;
        }
        const settings = this.model.internalModel.settings || {};
        const payload = { protocol: 2, session_id: this.session, frame: ++this.frame,
            model_name: settings.name || settings.json?.Name || 'Live2D', model_url: String(settings.url || ''),
            values, applied_revision: this.state.revision ?? null };
        if (now - this.lastCatalog >= 5000) {
            payload.parameters = [...this.catalog.values()].map(({ id, name, minimum, maximum, defaultValue }) =>
                ({ id, name, min: minimum, max: maximum, default: defaultValue }));
            this.lastCatalog = now;
        }
        this.pushing = true;
        this.request('/api/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(reply => {
                if (!this.active) return;
                if (reply.schema_required) this.lastCatalog = -Infinity;
                if (!this.connected) this.log('info', `[Live2DTuner] 实时参数已连接，共 ${this.catalog.size} 项`);
                this.connected = true;
            })
            .catch(() => { this.connected = false; this.lastCatalog = -Infinity; })
            .finally(() => { this.pushing = false; });
    }

    stop() {
        this.active = false;
        clearInterval(this.timer);
        for (const controller of this.controllers) controller.abort();
        this.controllers.clear();
    }
}

module.exports = { Live2DTunerBridge };
