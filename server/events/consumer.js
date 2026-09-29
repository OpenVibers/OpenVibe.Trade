'use strict';

/**
 * POST /internal/events — signed OpenVibe.Events webhook deliveries (subscription topic sources.*).
 *
 * The signature check, the ±300 s window and the exactly-once inbox are the ingest chassis
 * (openvibe-publishing/ingest, createEventConsumer); this route only maps its result onto HTTP and
 * wakes the Sources ingest. A webhook is a wake-up, not durable truth: a sources.item.* or
 * sources.fetch.failed event makes the cursor-based ingest run now, and the ingest reads the items
 * themselves from the Sources API. The route answers 404 while no secret is configured.
 */
const express = require('express');
const { createEventConsumer } = require('openvibe-publishing/ingest');
const { http } = require('openvibe-contracts');

const WAKE_RE = /^sources\.(item\.(created|updated|removed)|fetch\.failed)$/;

function createWebhook({ store, config, ingest, log = console }) {
    const router = express.Router();
    const consumer = createEventConsumer({ db: store.db, secrets: config.events.webhookSecret, consumer: 'sources', now: store.now });

    router.post('/internal/events', express.raw({ type: '*/*', limit: '1mb' }), async function receiveEventsDelivery(req, res, next) {
        if (!config.events.webhookSecret) return http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov });
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
        let r;
        try {
            r = await consumer.apply(raw, req.headers, async (e) => {
                const wake = WAKE_RE.test(e.event_type);
                if (wake) ingest.run().catch((err) => log.warn('[Trade] ingest after webhook failed:', err.message));
                return wake;
            });
        } catch (err) { return next(err); }
        if (r.status === 401) return http.sendProblem(res, 401, 'webhook.signature_invalid', { detail: 'The delivery signature does not verify', ctx: req.ov });
        if (r.status !== 200) return http.sendProblem(res, 400, 'webhook.malformed', { detail: 'Not an event envelope', ctx: req.ov });
        res.status(200).json({ accepted: true, duplicate: r.duplicate, sync: r.duplicate ? false : Boolean(r.outcome) });
    });

    return { router, consumer };
}

module.exports = { createWebhook };
