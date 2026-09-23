'use strict';

/**
 * POST /internal/events — signed OpenVibe.Events webhook deliveries (subscription topic sources.*).
 *
 * The body is verified against X-OpenVibe-Signature (HMAC-SHA256 of the raw body with
 * TRADE_EVENTS_WEBHOOK_SECRET) before anything is read; a bad or missing signature is 401 and the
 * route answers 404 while no secret is configured. Each event is recorded once in the SDK inbox
 * (idempotency_receipts, consumer 'sources'); a webhook is a wake-up, not durable truth: a
 * sources.item.* or sources.fetch.failed event makes the cursor-based sync run now, and the sync
 * reads the items themselves from the Sources API.
 */
const express = require('express');
const { parseDelivery, createInbox } = require('openvibe-sdk/events');
const { http } = require('openvibe-contracts');

function createWebhook({ store, config, sync, log = console }) {
    const router = express.Router();
    const inbox = createInbox(store.db, { now: store.now });
    inbox.ensureSchema();

    router.post('/internal/events', express.raw({ type: '*/*', limit: '1mb' }), function receiveEventsDelivery(req, res) {
        if (!config.events.webhookSecret) return http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov });
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
        // Signature v2 only: HMAC over "<t>.<raw body>" with t within ±300 s; a v1-only (v2 stripped) or stale delivery is refused.
        const delivery = parseDelivery(raw, req.headers, config.events.webhookSecret, { requireV2: true });
        if (!delivery) return http.sendProblem(res, 401, 'webhook.signature_invalid', { detail: 'The delivery signature does not verify', ctx: req.ov });
        const e = delivery.event;
        if (typeof e.event_id !== 'string' || typeof e.event_type !== 'string') return http.sendProblem(res, 400, 'webhook.malformed', { detail: 'Not an event envelope', ctx: req.ov });
        const r = inbox.once('sources', e.event_id, () => true);
        const wake = !r.duplicate && /^sources\.(item\.(created|updated|removed)|fetch\.failed)$/.test(e.event_type);
        if (wake) sync.run().catch((err) => log.warn('[Trade] sync after webhook failed:', err.message));
        res.status(200).json({ accepted: true, duplicate: r.duplicate, sync: wake });
    });

    return { router, inbox };
}

module.exports = { createWebhook };
