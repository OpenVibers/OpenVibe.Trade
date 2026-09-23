'use strict';
/**
 * Watchlists never leak: private cache headers, noindex, owner-only (404 for anyone else), never in
 * sitemaps, feeds, robots-allowed paths, Search documents or events. Works without JavaScript
 * through plain forms with a form token.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    t.instrument({ symbol: 'ACME', name: 'Acme Corp' });
    t.instrument({ symbol: 'ZETA', name: 'Zeta Holdings' });
    const form = (user, fields) => ({ as: user, form: { _csrf: t.csrf(user), ...fields } });
    let wlId;

    await check('anonymous /watchlists is a sign-in prompt, private and noindex', async () => {
        const r = await t.get('/watchlists');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('Sign in'));
        assert.ok(/private/.test(r.headers.get('cache-control')) && /no-store/.test(r.headers.get('cache-control')));
        assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow');
        assert.ok(r.text.includes('<meta name="robots" content="noindex, nofollow">'));
    });

    await check('alice creates a watchlist and adds instruments with plain forms (no JavaScript)', async () => {
        const c = await t.get('/watchlists', form(t.alice, { name: 'Secret plans' }));
        assert.strictEqual(c.status, 303);
        assert.ok(/private, no-store/.test(c.headers.get('cache-control')));
        wlId = t.ctx.watchlists.forOwner(t.alice.subject)[0].id;
        assert.strictEqual((await t.get('/watchlists/item', form(t.alice, { watchlist_id: wlId, symbol: 'ACME' }))).status, 303);
        assert.strictEqual((await t.get('/watchlists/item', form(t.alice, { watchlist_id: wlId, q: 'Zeta Holdings' }))).status, 303);
        const page = await t.get('/watchlists', { as: t.alice });
        assert.ok(page.text.includes('Secret plans') && page.text.includes('ACME') && page.text.includes('ZETA'));
        assert.ok(/private/.test(page.headers.get('cache-control')) && /no-store/.test(page.headers.get('cache-control')));
        assert.ok(/Cookie/.test(page.headers.get('vary')));
        assert.strictEqual(page.headers.get('x-robots-tag'), 'noindex, nofollow');
    });

    await check('a form without the right token changes nothing', async () => {
        const r = await t.get('/watchlists', { as: t.alice, form: { _csrf: 'forged', name: 'Injected' } });
        assert.strictEqual(r.status, 403);
        const r2 = await t.get('/watchlists', { as: t.alice, form: { _csrf: t.csrf(t.bob), name: 'Injected' } });
        assert.strictEqual(r2.status, 403);
        assert.strictEqual(t.ctx.watchlists.forOwner(t.alice.subject).length, 1);
    });

    await check('bob cannot see, change or delete alice\'s watchlist (404, existence not disclosed)', async () => {
        const bobPage = await t.get('/watchlists', { as: t.bob });
        assert.ok(!bobPage.text.includes('Secret plans'));
        assert.strictEqual((await t.get(`/api/v1/watchlists/${wlId}`, { as: t.bob })).status, 404);
        assert.strictEqual((await t.get(`/api/v1/watchlists/${wlId}`, { as: t.bob, method: 'PATCH', json: { name: 'x' } })).status, 404);
        assert.strictEqual((await t.get(`/api/v1/watchlists/${wlId}/items/ACME`, { as: t.bob, method: 'DELETE' })).status, 404);
        assert.strictEqual((await t.get(`/api/v1/watchlists/${wlId}`, { as: t.bob, method: 'DELETE' })).status, 404);
        const del = await t.get('/watchlists/delete', form(t.bob, { watchlist_id: wlId }));
        assert.strictEqual(del.status, 303);
        assert.strictEqual(new URL(del.headers.get('location'), 'https://x').searchParams.get('e'), 'No such watchlist');
        assert.strictEqual(t.ctx.watchlists.forOwner(t.alice.subject).length, 1, 'still there');
        assert.strictEqual((await t.get(`/api/v1/watchlists/${wlId}`)).status, 401, 'anonymous API');
    });

    await check('the API answers the owner, privately', async () => {
        const r = await t.get('/api/v1/watchlists', { as: t.alice });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.json().watchlists[0].items.map((i) => i.instrument.symbol), ['ACME', 'ZETA']);
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex');
    });

    await check('a service needs trade.watchlist.* and X-OV-Subject, and sees only that person\'s lists', async () => {
        const reader = t.network.serviceToken('network', ['trade.watchlist.read']);
        assert.strictEqual((await t.get('/api/v1/watchlists', { as: reader })).status, 400);
        const asBob = await t.get('/api/v1/watchlists', { as: reader, headers: { 'x-ov-subject': t.bob.subject } });
        assert.deepStrictEqual(asBob.json().watchlists, []);
        const asAlice = await t.get('/api/v1/watchlists', { as: reader, headers: { 'x-ov-subject': t.alice.subject } });
        assert.strictEqual(asAlice.json().watchlists.length, 1);
        assert.strictEqual((await t.get('/api/v1/watchlists', { as: reader, method: 'POST', json: { name: 'x' }, headers: { 'x-ov-subject': t.alice.subject } })).status, 403);
        const wrongAud = t.network.signService({ sub: 'svc:network', aud: ['openvibe.blog'], cap: ['trade.watchlist.read'] });
        assert.strictEqual((await t.get('/api/v1/watchlists', { as: wrongAud, headers: { 'x-ov-subject': t.alice.subject } })).status, 401);
    });

    await check('an instrument page shown to a signed-in person (with her watchlist names) is private; anonymous is public', async () => {
        const mine = await t.get('/i/ACME', { as: t.alice });
        assert.ok(mine.text.includes('Secret plans'), 'her own list offered in the add form');
        assert.ok(/private/.test(mine.headers.get('cache-control')) && /no-store/.test(mine.headers.get('cache-control')));
        const anon = await t.get('/i/ACME');
        assert.ok(!anon.text.includes('Secret plans'));
        assert.strictEqual(anon.headers.get('cache-control'), 'public, max-age=60');
        assert.ok(/Cookie/.test(anon.headers.get('vary')));
    });

    await check('watchlists never appear in sitemaps, feeds, robots-allowed paths, Search documents or events', async () => {
        const blobs = [];
        for (const p of ['/sitemap.xml', '/sitemaps/instruments.xml', '/feed.xml', '/atom.xml', '/feed.json', '/i/ACME/documents.xml', '/llms.txt', '/i/ACME.json', '/', '/sources']) {
            const r = await t.get(p);
            assert.ok(r.status < 400, `${p} ${r.status}`);
            blobs.push(r.text);
        }
        const all = blobs.join('\n');
        assert.ok(!all.includes('Secret plans'));
        assert.ok(!all.includes(wlId));
        assert.ok(!all.includes(t.alice.subject));
        const robots = (await t.get('/robots.txt')).text;
        for (const p of ['/watchlists', '/alerts', '/editor', '/api/']) assert.ok(robots.includes(`Disallow: ${p}`), p);
        const events = JSON.stringify(t.events());
        assert.ok(!events.includes(wlId) && !events.includes('Secret plans') && !events.includes('watchlist'));
        assert.ok(!t.events().some((e) => e.event_type.includes('watchlist')));
    });

    await check('removing and deleting work for the owner', async () => {
        assert.strictEqual((await t.get('/watchlists/item/remove', form(t.alice, { watchlist_id: wlId, symbol: 'ZETA' }))).status, 303);
        assert.deepStrictEqual(t.ctx.watchlists.items(t.ctx.watchlists.forOwner(t.alice.subject)[0]).map((i) => i.symbol), ['ACME']);
        assert.strictEqual((await t.get('/watchlists/delete', form(t.alice, { watchlist_id: wlId }))).status, 303);
        assert.strictEqual(t.ctx.watchlists.forOwner(t.alice.subject).length, 0);
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM trade_watchlist_items WHERE watchlist_id = ?').get(wlId).n, 0);
    });

    await t.close();
    done();
})();
