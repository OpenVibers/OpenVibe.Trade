'use strict';

/**
 * Alert rules and their deliveries. Rules are private: one owner (usr_…), never shown to anyone
 * else, never indexed, never in a feed.
 *
 *   threshold      metric + above|below + threshold + unit (+ currency). Fires on a CROSSING: when
 *                  a new observation (newer than the last one the rule evaluated, matching metric,
 *                  unit and currency exactly — there is no conversion) meets the condition while
 *                  the rule is armed; it re-arms when a newer observation no longer meets it.
 *                  Older observations arriving late are recorded but never trigger.
 *   filing_type    a newly seen document of the instrument whose form type is in the list
 *   new_document   any newly seen document of the instrument
 *
 * Idempotency: a delivery is the row (rule, trigger kind, trigger id) under a UNIQUE key, written
 * in the same transaction as the observation or document that triggered it and as its
 * `trade.alert.triggered` event. Re-processing the same observation or document (a replayed
 * sync, a retried request, a second worker) inserts nothing and emits nothing. No email is sent:
 * the event (visibility subject, subject = the owner) is for Notifications and the owner's own
 * realtime stream. Following ADR-020, the payload is data (rule, instrument, trigger with its
 * timestamps and source), never rendered notification text: Network renders the notification.
 */
const { ApiError } = require('../http/errors');
const { newId, iso, parseDecimal, invalid, str, json } = require('./util');
const { formType } = require('./mapping');

const KINDS = ['threshold', 'filing_type', 'new_document'];
const DISCLAIMER = 'Information only — not investment advice; no trading here.';

function createAlerts({ store, config, ctx }) {
    const { db } = store;
    const q = {
        byId: db.prepare('SELECT * FROM trade_alert_rules WHERE id = ?'),
        insert: db.prepare(`INSERT INTO trade_alert_rules (id, owner_subject, instrument_id, kind, metric, operator, threshold, threshold_num, unit, currency, form_types, created_at, updated_at)
                            VALUES (@id, @owner, @instrument_id, @kind, @metric, @operator, @threshold, @threshold_num, @unit, @currency, @form_types, @now, @now)`),
        countOwner: db.prepare("SELECT COUNT(*) AS n FROM trade_alert_rules WHERE owner_subject = ? AND status = 'active'"),
        forOwner: db.prepare("SELECT r.*, i.symbol, i.name AS instrument_name FROM trade_alert_rules r JOIN trade_instruments i ON i.id = r.instrument_id WHERE r.owner_subject = ? AND r.status = 'active' ORDER BY r.created_at DESC"),
        remove: db.prepare("UPDATE trade_alert_rules SET status = 'deleted', updated_at = ? WHERE id = ? AND status = 'active'"),
        thresholds: db.prepare("SELECT * FROM trade_alert_rules WHERE instrument_id = ? AND status = 'active' AND kind = 'threshold' AND metric = ? AND unit = ?"),
        docRules: db.prepare("SELECT * FROM trade_alert_rules WHERE instrument_id = ? AND status = 'active' AND kind IN ('filing_type','new_document')"),
        setState: db.prepare('UPDATE trade_alert_rules SET armed = @armed, last_observed_at = @observed, updated_at = @now WHERE id = @id'),
        deliver: db.prepare(`INSERT OR IGNORE INTO trade_alert_deliveries (id, rule_id, owner_subject, trigger_kind, trigger_id, summary, created_at)
                             VALUES (@id, @rule_id, @owner, @kind, @trigger_id, @summary, @now)`),
        setEvent: db.prepare('UPDATE trade_alert_deliveries SET event_id = ? WHERE id = ?'),
        deliveries: db.prepare(`SELECT d.*, r.kind AS rule_kind FROM trade_alert_deliveries d JOIN trade_alert_rules r ON r.id = d.rule_id
                                WHERE d.owner_subject = ? ORDER BY d.created_at DESC, d.id DESC LIMIT ?`),
        countFor: db.prepare('SELECT COUNT(*) AS n FROM trade_alert_deliveries WHERE rule_id = ?'),
    };

    function ruleDto(r, instrument) {
        const ins = instrument || ctx.instruments.get(r.instrument_id);
        return {
            id: r.id, kind: r.kind, status: r.status,
            instrument: ins ? { id: ins.id, symbol: ins.symbol, name: ins.name } : { id: r.instrument_id },
            metric: r.metric, operator: r.operator, threshold: r.threshold, unit: r.unit, currency: r.currency,
            form_types: r.form_types ? json(r.form_types, []) : null,
            armed: r.kind === 'threshold' ? Boolean(r.armed) : null,
            created_at: iso(r.created_at), updated_at: iso(r.updated_at),
        };
    }

    function deliver(rule, instrument, kind, trigger, summary, { traceparent } = {}) {
        const id = newId('ald', store.now());
        const info = q.deliver.run({ id, rule_id: rule.id, owner: rule.owner_subject, kind, trigger_id: trigger.id, summary: JSON.stringify(summary), now: store.now() });
        if (!info.changes) return null;   // already delivered for this (rule, trigger)
        const env = ctx.outbox.emit({
            event_type: 'trade.alert.triggered', actor: { type: 'service', id: 'trade' }, visibility: 'subject', priority: 'important',
            subject: { type: 'user', id: rule.owner_subject },
            payload: {
                delivery_id: id,
                rule: ruleDto(rule, instrument),
                instrument: { id: instrument.id, symbol: instrument.symbol, name: instrument.name, url: ctx.urls.instrument(instrument) },
                trigger: { kind, id: trigger.id, ...summary },
                disclaimer: DISCLAIMER,
            },
        }, { traceparent });
        q.setEvent.run(env.event_id, id);
        return { id, event_id: env.event_id };
    }

    const api = {
        KINDS,
        DISCLAIMER,
        get: (id) => q.byId.get(id) || null,
        dto: ruleDto,

        forOwner(subject) { return q.forOwner.all(subject).map((r) => ruleDto(r, { id: r.instrument_id, symbol: r.symbol, name: r.instrument_name })); },

        deliveries(subject, limit = 50) {
            return q.deliveries.all(subject, Math.min(Math.max(Number(limit) || 50, 1), 200)).map((d) => ({
                id: d.id, rule_id: d.rule_id, rule_kind: d.rule_kind, trigger: { kind: d.trigger_kind, id: d.trigger_id, ...json(d.summary, {}) },
                event_id: d.event_id, created_at: iso(d.created_at),
            }));
        },
        deliveryCount: (ruleId) => q.countFor.get(ruleId).n,

        create(subject, instrument, input) {
            if (!subject) throw new ApiError(403, 'subject.required', 'Alert rules belong to a person');
            if (!instrument || instrument.status !== 'active') throw new ApiError(404, 'instrument.not_found', 'No such active instrument');
            const kind = String(input.kind || '');
            if (!KINDS.includes(kind)) throw invalid(`kind must be one of ${KINDS.join(', ')}`);
            if (q.countOwner.get(subject).n >= config.limits.alertRulesPerSubject) throw new ApiError(429, 'alert.limit', `At most ${config.limits.alertRulesPerSubject} alert rules`);
            const row = { id: newId('alr', store.now()), owner: subject, instrument_id: instrument.id, kind, metric: null, operator: null, threshold: null, threshold_num: null, unit: null, currency: null, form_types: null, now: store.now() };
            if (kind === 'threshold') {
                row.metric = str(input.metric, 80, 'metric', { required: true });
                if (!['above', 'below'].includes(input.operator)) throw invalid('operator must be above or below');
                row.operator = input.operator;
                const t = parseDecimal(input.threshold);
                if (!t) throw invalid('threshold must be a finite decimal');
                row.threshold = t.text; row.threshold_num = t.num;
                row.unit = str(input.unit, 20, 'unit', { required: true });
                const c = input.currency == null || input.currency === '' ? null : String(input.currency).trim().toUpperCase();
                if (c && !/^[A-Z]{3}$/.test(c)) throw invalid('currency must be an ISO 4217 code like USD');
                row.currency = c;
            } else if (kind === 'filing_type') {
                const raw = Array.isArray(input.form_types) ? input.form_types : String(input.form_types || '').split(',');
                const list = [...new Set(raw.map((x) => formType(String(x))).filter(Boolean))];
                if (!list.length || list.length > 10) throw invalid('form_types must list 1–10 form types, e.g. 10-K, 10-Q, 8-K');
                row.form_types = JSON.stringify(list);
            }
            q.insert.run(row);
            return q.byId.get(row.id);
        },

        remove(subject, id) {
            const r = q.byId.get(id);
            // Someone else's rule is "not found": its existence is not disclosed.
            if (!r || r.owner_subject !== subject || r.status !== 'active') throw new ApiError(404, 'alert.not_found', 'No such alert rule');
            q.remove.run(store.now(), id);
            return true;
        },

        /** Inside the transaction that recorded `obs`. */
        onObservation(obs, instrument, opts = {}) {
            const out = [];
            for (const rule of q.thresholds.all(instrument.id, obs.metric, obs.unit)) {
                if (rule.currency && rule.currency !== obs.currency) continue;
                if (rule.created_at > obs.recorded_at) continue;
                if (rule.last_observed_at != null && obs.observed_at <= rule.last_observed_at) continue;   // late arrival
                const meets = rule.operator === 'above' ? obs.value_num > rule.threshold_num : obs.value_num < rule.threshold_num;
                let armed = rule.armed;
                if (meets && armed) {
                    const d = deliver(rule, instrument, 'observation', obs, {
                        metric: obs.metric, value: obs.value, unit: obs.unit, currency: obs.currency,
                        observed_at: iso(obs.observed_at), retrieved_at: iso(obs.retrieved_at), source_key: obs.source_key, source_url: obs.source_url,
                    }, opts);
                    if (d) out.push(d);
                    armed = 0;
                } else if (!meets) {
                    armed = 1;
                }
                q.setState.run({ id: rule.id, armed, observed: obs.observed_at, now: store.now() });
            }
            return out;
        },

        /** Inside the transaction that first recorded `doc`. */
        onDocument(doc, instrument, opts = {}) {
            const out = [];
            for (const rule of q.docRules.all(instrument.id)) {
                if (rule.kind === 'filing_type') {
                    const types = json(rule.form_types, []);
                    if (!doc.form_type || !types.includes(doc.form_type)) continue;
                }
                const d = deliver(rule, instrument, 'document', doc, {
                    form_type: doc.form_type, title: doc.title, url: doc.url, published_at: iso(doc.published_at),
                    retrieved_at: iso(doc.retrieved_at), source_key: doc.source_key,
                }, opts);
                if (d) out.push(d);
            }
            return out;
        },
    };
    return api;
}

module.exports = { createAlerts, DISCLAIMER };
