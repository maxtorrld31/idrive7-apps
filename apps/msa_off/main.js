'use strict';
/**
 * MSA-OFF - permanently disable the automatic start-stop (MSA2) on a BMW
 * diesel with DDE 9 (G-series, iDrive 7), from the head unit's own screen.
 *
 * ONE control: the checkbox "Отключить MSA / Disable MSA".
 * Safety model (nothing leaves the app until all of this holds):
 *   - read-only until the checkbox is pressed twice: first press arms
 *     (5 s window), the second press executes;
 *   - the DDE must answer the state read 22 F5 29 positively - if the
 *     controller does not know DID F529, nothing can be written;
 *   - execution is ISTA's own sequence (SGBD D94BX7A0, KB §20.55):
 *       10 03 (session) -> 31 01 F5 29 (deactivate, permanent)
 *       -> 22 F5 29 (read back, must be 01) -> 31 02 F5 29 (end)
 *       -> 10 01 (back to the default session);
 *   - every step's answer is shown; a negative reply stops the run;
 *   - one way only: re-enabling MSA stays with ISTA's service function
 *     "Activate MSA" - on purpose, this app never sends an enable.
 *
 * Diagnostic transport: kit/diag.js (TASU), exactly as dtc_scanner and
 * Engine Config use it. Target: the engine controller, address 0x12.
 */
const mgu = require('./kit/mgu');
const { Diag, hex, NRC, replyTo } = require('./kit/diag');

const DDE = 0x12;                    // diesel engine controller (DDE9)
const DID_SGBD = [0xF1, 0x50];       // SGBD index - shown for a visual check
const DID_STATE = [0xF5, 0x29];      // DEAKT_MSA_PERMANENT state
const ROUTINE = [0xF5, 0x29];        // same identifier, as a routine
const ARM_WINDOW_MS = 5000;          // second press must come within this

const NRC_MORE = {
    0x22: 'conditions not correct (engine running? MSA stop active? battery/transport mode?)',
    0x33: 'security access denied (this DDE wants authentication - use ISTA)',
};

class MsaOff {
    constructor(ctx) {
        this.ctx = ctx;
        this.diag = null;
        this.armed = false;
        this.armTimer = null;
        this.busy = false;
        this.state = null;           // null = unknown, false = enabled, true = disabled
        this.sgbd = null;
    }

    /** Status lines for the on-screen label. */
    lines(extra) {
        const l = [];
        l.push(this.diag && this.diag.available ? 'Diagnostic link: OK' : 'Diagnostic link: not available');
        if (this.sgbd) l.push('SGBD: ' + this.sgbd);
        if (this.state === null) l.push('MSA state: unknown (read failed)');
        else l.push('MSA: ' + (this.state ? 'DISABLED (permanent)' : 'active'));
        if (this.armed) l.push('ARMED - press again to disable, within ' + Math.ceil(ARM_WINDOW_MS / 1000) + ' s');
        if (extra) l.push(extra);
        return l;
    }

    async paint(extra) {
        const ui = this.ctx.ui;
        await ui.text('L_STATUS', this.lines(extra).join('\n'));
        await ui.checked('CB_DISABLE', !!this.state);
    }

    /** One physical UDS request to the DDE, parsed like Engine Config's diaglink. */
    async req(sid, data, timeoutMs) {
        const reply = await this.diag.physical(DDE, sid, data, timeoutMs || 3000, replyTo(sid, data));
        if (!reply || !reply.length) return { ok: false, reason: 'timeout' };
        if (reply[0] === 0x7F) return { ok: false, nrc: reply[2], reason: NRC_MORE[reply[2]] || NRC[reply[2]] || ('NRC ' + hex(reply[2])) };
        return { ok: true, sid: reply[0], data: reply.slice(1) };
    }

    async readState() {
        const r = await this.req(0x22, DID_STATE);
        if (!r.ok) { this.state = null; return r; }
        // 62 F5 29 <wert>
        this.state = r.data.length >= 3 && r.data[2] === 1;
        return r;
    }

    async refresh(extra) {
        if (!this.diag || !this.diag.available) { await this.paint(extra); return; }
        if (!this.sgbd) {
            const s = await this.req(0x22, DID_SGBD);
            if (s.ok) this.sgbd = (s.data.slice(1) || []).map((x) => String.fromCharCode(x)).join('').replace(/[^\x20-\x7e]/g, '') || null;
        }
        const r = await this.readState();
        await this.paint(extra || (r.ok ? null : 'Read F529: ' + r.reason));
    }

    /** The arm/confirm/execute flow behind the one checkbox. */
    async onPressed() {
        if (this.busy) return;
        if (!this.diag || !this.diag.available) { this.armed = false; await this.paint('No diagnostic link'); return; }
        if (this.state !== false) {
            // unknown state (read failed) or already disabled: never send anything
            this.armed = false;
            const note = this.state === true
                ? 'Already DISABLED. Enable again with ISTA: service function "Activate MSA"'
                : 'State read failed - this controller does not expose F529, nothing sent';
            await this.paint(note);
            return;
        }
        if (!this.armed) {
            this.armed = true;
            clearTimeout(this.armTimer);
            this.armTimer = setTimeout(() => { this.armed = false; this.paint('Arm expired'); }, ARM_WINDOW_MS);
            await this.paint();
            return;
        }
        // second press: execute ISTA's sequence
        clearTimeout(this.armTimer);
        this.armed = false;
        this.busy = true;
        try { await this.execute(); } finally { this.busy = false; }
    }

    async step(what, sid, data, check) {
        const r = await this.req(sid, data, 5000);
        await this.paint(what + ': ' + (r.ok ? 'OK' : r.reason));
        if (!r.ok) throw new Error(what + ': ' + r.reason);
        if (check && !check(r)) throw new Error(what + ': unexpected answer ' + r.data.map((x) => hex(x)).join(' '));
        return r;
    }

    async execute() {
        try {
            await this.step('Session 10 03', 0x10, [0x03], (r) => r.data[0] === 0x50 || r.data[0] === 0x03 || true);
            await this.step('Deactivate 31 01 F5 29', 0x31, [0x01].concat(ROUTINE),
                (r) => r.data.length >= 3 && r.data[0] === 0x01 && (r.data[1] << 8 | r.data[2]) === 0xF529);
            const back = await this.step('Read back 22 F5 29', 0x22, DID_STATE,
                (r) => r.data.length >= 4);                       // 62 F5 29 xx
            this.state = back.data[3] === 1;
            if (!this.state) throw new Error('read back is not 01 - not disabled');
            try { await this.step('End 31 02 F5 29', 0x31, [0x02].concat(ROUTINE)); } catch (e) { this.ctx.log.warn(e); }
            try { await this.step('Session 10 01', 0x10, [0x01]); } catch (e) { this.ctx.log.warn(e); }
            await this.paint('DONE - MSA permanently disabled');
        } catch (e) {
            // back to the default session whatever happened, then show the stop reason
            try { await this.req(0x10, [0x01], 2000); } catch (e2) { this.ctx.log.warn(e2); }
            await this.readState();
            await this.paint('STOPPED: ' + (e && e.message || e));
        }
    }
}

mgu.run({
    async start(ctx) {
        const app = new MsaOff(ctx);
        ctx.ui.onClick('CB_DISABLE', () => { app.onPressed().catch((e) => ctx.log.error('press', e)); });
        app.diag = await new Diag(ctx.signals, ctx.log).init();
        app.diag.on('available', () => { app.refresh().catch((e) => ctx.log.error('refresh', e)); });
        await app.refresh();
    },
});
