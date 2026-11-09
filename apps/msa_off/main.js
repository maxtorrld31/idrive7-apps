'use strict';
/**
 * MSA-OFF v0.2.0 — permanently disable the automatic start-stop (MSA2) on a
 * BMW diesel with DDE 9, from the head unit's screen. Works on ID7 and ID8.
 *
 * ONE control: the "Disable MSA" button. Safety model:
 *   1. tasu-guard: UDS writes only with the car parked (speed < 1 km/h,
 *      engine < 50 rpm, both fresh; flash services blocked always)
 *   2. arm + confirm: first press arms (5 s), second press executes
 *   3. ISTA's exact sequence (SGBD D94BX7A0, KB §20.55):
 *        10 03 -> 31 01 F5 29 -> read-back 22 F5 29 (= 01) -> 31 02 F5 29 -> 10 01
 *   4. one-way: re-enabling stays with ISTA ("Activate MSA")
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Canvas } = require('./kit/canvas');
const { Diag, hex, NRC, replyTo } = require('./kit/diag');

const DDE = 0x12;
const DID_SGBD = [0xF1, 0x50];
const DID_STATE = [0xF5, 0x29];
const ROUTINE = [0xF5, 0x29];
const ARM_WINDOW_MS = 5000;
const W = 1920, H = 504;

const READ_SIDS = [0x01, 0x02, 0x03, 0x06, 0x07, 0x09, 0x0A, 0x19, 0x22, 0x3E];
const BLOCKED_SIDS = [0x34, 0x35, 0x36, 0x37, 0x38, 0x3D];

class MsaOff {
    constructor(ctx) {
        this.ctx = ctx;
        this.diag = null;
        this.armed = false;
        this.armTimer = null;
        this.busy = false;
        this.state = null;
        this.sgbd = null;
        this.note = '';
    }

    parked(car) {
        const d = car.data();
        if (d.demo) return { ok: false, why: 'demo data' };
        if (!Number.isFinite(d.speed) || d.speed < 0) return { ok: false, why: 'vehicle speed unknown' };
        if (d.speed >= 1) return { ok: false, why: 'the car is moving' };
        if (!Number.isFinite(d.rpm) || d.rpm < 0) return { ok: false, why: 'engine speed unknown' };
        if (d.rpm >= 50) return { ok: false, why: 'the engine is running' };
        return { ok: true, why: '' };
    }

    guardCheck(sid, car) {
        if (BLOCKED_SIDS.indexOf(sid) >= 0) return { ok: false, why: 'service ' + hex(sid) + ' is never allowed' };
        if (READ_SIDS.indexOf(sid) >= 0) return { ok: true, why: '' };
        if (sid === 0x10) return { ok: true, why: '' };
        const p = this.parked(car);
        return p.ok ? p : { ok: false, why: p.why };
    }

    async req(sid, data, car, timeoutMs) {
        const g = this.guardCheck(sid, car);
        if (!g.ok) return { ok: false, reason: g.why };
        const reply = await this.diag.physical(DDE, sid, data, timeoutMs || 3000, replyTo(sid, data));
        if (!reply || !reply.length) return { ok: false, reason: 'timeout' };
        if (reply[0] === 0x7F) {
            const nrc = reply[2];
            const more = { 0x22: 'conditions not correct (engine running? MSA stop? battery?)', 0x33: 'security access denied (use ISTA)' };
            return { ok: false, nrc, reason: more[nrc] || NRC[nrc] || 'NRC ' + hex(nrc) };
        }
        return { ok: true, sid: reply[0], data: reply.slice(1) };
    }

    async readState(car) {
        const r = await this.req(0x22, DID_STATE, car);
        if (!r.ok) { this.state = null; return r; }
        this.state = r.data.length >= 3 && r.data[2] === 1;
        return r;
    }

    async refresh(car) {
        if (!this.diag || !this.diag.available) { this.note = 'No diagnostic link'; return; }
        if (!this.sgbd && car) {
            const s = await this.req(0x22, DID_SGBD, car);
            if (s.ok) this.sgbd = (s.data.slice(1) || []).map((x) => String.fromCharCode(x)).join('').replace(/[^\x20-\x7e]/g, '') || null;
        }
        if (car) {
            const r = await this.readState(car);
            this.note = r.ok ? '' : 'Read F529: ' + r.reason;
        }
    }

    async onPressed(car) {
        if (this.busy) return;
        if (!this.diag || !this.diag.available) { this.armed = false; this.note = 'No diagnostic link'; return; }
        if (this.state !== false) {
            this.armed = false;
            this.note = this.state === true
                ? 'Already DISABLED. Enable with ISTA "Activate MSA"'
                : 'State unknown (read failed). Nothing sent.';
            return;
        }
        if (!this.armed) {
            const p = this.parked(car);
            if (!p.ok) { this.armed = false; this.note = 'Not parked: ' + p.why; return; }
            this.armed = true;
            clearTimeout(this.armTimer);
            this.armTimer = setTimeout(() => { this.armed = false; this.note = 'Arm expired'; }, ARM_WINDOW_MS);
            this.note = '';
            return;
        }
        clearTimeout(this.armTimer);
        this.armed = false;
        this.busy = true;
        try { await this.execute(car); } finally { this.busy = false; }
    }

    async step(what, sid, data, car, check) {
        const r = await this.req(sid, data, car, 5000);
        this.note = what + ': ' + (r.ok ? 'OK' : r.reason);
        if (!r.ok) throw new Error(what + ': ' + r.reason);
        if (check && !check(r)) throw new Error(what + ': unexpected answer');
        return r;
    }

    async execute(car) {
        try {
            await this.step('Session 10 03', 0x10, [0x03], car);
            await this.step('Deactivate 31 01 F5 29', 0x31, [0x01].concat(ROUTINE), car,
                (r) => r.data.length >= 3 && r.data[0] === 0x01 && (r.data[1] << 8 | r.data[2]) === 0xF529);
            const back = await this.step('Read back 22 F5 29', 0x22, DID_STATE, car,
                (r) => r.data.length >= 4);
            this.state = back.data[3] === 1;
            if (!this.state) throw new Error('read back is not 01');
            try { await this.step('End 31 02 F5 29', 0x31, [0x02].concat(ROUTINE), car); } catch (e) { this.ctx.log.warn(e); }
            try { await this.step('Session 10 01', 0x10, [0x01], car); } catch (e) { this.ctx.log.warn(e); }
            this.note = 'DONE — MSA permanently disabled';
        } catch (e) {
            try { await this.req(0x10, [0x01], car, 2000); } catch (e2) { this.ctx.log.warn(e2); }
            if (car) await this.readState(car);
            this.note = 'STOPPED: ' + (e && e.message || e);
        }
    }
}

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        const app = new MsaOff(ctx);
        const car = new (require('./kit/car'))(ctx, ['rpm', 'speed']);

        ui.onClick('BTN_DISABLE', () => { app.onPressed(car).catch((e) => log.error('press', e)); });

        app.diag = await new Diag(ctx.signals, ctx.log).init();
        app.diag.on('available', () => { app.refresh(car).catch((e) => log.error('refresh', e)); });

        const render = async () => {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H) || new Canvas(W, H);
            cv.rect(0, 0, W, H, t.bg);

            const cx = W / 2, cy = H / 2 - 40;
            const active = app.state === false;
            const disabled = app.state === true;
            const color = disabled ? t.red : active ? t.green : t.dim;
            const label = disabled ? 'MSA DISABLED' : active ? 'MSA ACTIVE' : 'MSA UNKNOWN';

            // status ring
            const r = 140;
            for (let i = 0; i < 360; i += 2) {
                const rad = i * Math.PI / 180;
                cv.arc(cx, cy, r, rad, rad + 0.04, color, 16);
            }

            cv.text(cx, cy + 10, label, t.white, 48, G.align.c);

            // info line
            let info = '';
            if (app.sgbd) info += 'SGBD: ' + app.sgbd + '  ';
            info += app.diag && app.diag.available ? 'Link OK' : 'No link';
            cv.text(cx, cy + r + 50, info, t.dim, 28, G.align.c);

            // status / arm / note
            let status = '';
            if (app.busy) status = app.note || 'Working...';
            else if (app.armed) status = 'ARMED — press again to disable (5 s)';
            else if (app.note) status = app.note;
            if (status) cv.text(cx, cy + r + 100, status, app.armed ? t.yellow : t.white, 32, G.align.c);

            await ui.image('MAIN_GFX', cv);
        };

        // initial read (after the car data starts flowing)
        setTimeout(() => { app.refresh(car).catch((e) => log.error('refresh', e)); }, 3000);
        ctx.loop('MAIN', 4, render);
    },
});
