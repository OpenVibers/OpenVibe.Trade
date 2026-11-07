'use strict';
/**
 * Sharing a watchlist (design 2026-11-06, visibility step 6): the one Share sheet (openvibe-sdk/share) and the one
 * check, canView, on the watchlist page and its API. Editing asks canEdit, so Specific people with Can edit build a
 * list together.
 *
 *   - a new watchlist is Only me; its card carries the Share button for its owner;
 *   - Anyone with the link reads the list page and the API, and only its owner (or an editor) changes it;
 *   - Specific people shows the gate, never the list's name or its instruments, to somebody not on the list;
 *   - Can edit really adds and removes instruments; Can view only reads;
 *   - the person's default for new lists, and "apply to all", work;
 *   - a watchlist is never on a gathered page: not the sitemap, not llms.txt.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const sharing = require('../server/sharing');
const { createWatchlists } = require('../server/domain/watchlists');
const { createPrivate } = require('../server/http/private');

(async () => {
    const t = await boot();
    try {
        await check('the sharing wiring loads: watchlists are never Everyone, and an editor is not staff here', async () => {
            assert.strictEqual(sharing.SERVICE, 'trade');
            assert.strictEqual(sharing.KIND, 'watchlist');
            assert.deepStrictEqual(sharing.OFFERED, ['private', 'link', 'people']);
            assert.strictEqual(sharing.shareViewer({ kind: 'anonymous', subject: null }), null);
            assert.deepStrictEqual(sharing.shareViewer({ kind: 'user', subject: 'usr_x', editor: true }), { subject: { type: 'user', id: 'usr_x' }, staff: false });
            assert.strictEqual(typeof createWatchlists, 'function');
            assert.strictEqual(typeof createPrivate, 'function');
        });
        const kim = t.network.addUser('kim');
        const bo = t.network.addUser('bo');
        const cy = t.network.addUser('cy');
        const acme = await t.instrument({ symbol: 'ACME', name: 'Acme Corp', exchange: 'NYSE' });
        const beta = await t.instrument({ symbol: 'BETA', name: 'Beta Holdings', exchange: 'NYSE' });

        const call = (pathname, o = {}) => {
            const { headers, ...rest } = o;
            return t.get(pathname, { ...rest, headers: { 'x-requested-with': 'ov-share', ...(headers || {}) } });
        };
        const share = (id, o = {}) => call(`/api/v1/watchlist/${encodeURIComponent(id)}/share`, o);
        const setShare = async (id, body, as) => {
            const first = await share(id, { as });
            assert.strictEqual(first.status, 200, first.text);
            const etag = first.headers.get('etag');
            assert.ok(etag);
            return await share(id, { as, method: 'PUT', json: body, headers: { 'if-match': etag } });
        };
        const audienceRow = async (id) => await t.ctx.store.db.maybe(
            'SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', ['trade', 'watchlist', id]);
        const newList = async (as, name = 'Semis') => {
            const made = await t.get('/api/v1/watchlists', { as, json: { name } });
            assert.strictEqual(made.status, 201, made.text);
            const id = made.json().watchlist.id;
            return id;
        };

        let id;
        await check('a new watchlist is Only me, and its card carries the Share button for its owner', async () => {
            id = await newList(kim);
            assert.deepStrictEqual(await audienceRow(id), { audience: 'private' });
            await t.get(`/api/v1/watchlists/${id}/items/ACME`, { method: 'PUT', as: kim, json: { note: 'watching' } });
            const mine = await t.get('/watchlists', { as: kim });
            assert.strictEqual(mine.status, 200, mine.text);
            assert.ok(mine.text.includes('data-ov-share-sheet') && mine.text.includes('data-kind="watchlist"'));
            assert.ok(mine.text.includes('ov-share.js'));
            assert.ok(mine.text.includes('Who can open a new watchlist'));
            const own = await t.get(`/watchlists/${id}`, { as: kim });
            assert.strictEqual(own.status, 200, own.text);
            assert.ok(own.text.includes('Semis') && own.text.includes('ACME'));
            const other = await t.get(`/watchlists/${id}`, { as: bo });
            assert.strictEqual(other.status, 404);
            assert.ok(!other.text.includes('Semis'), 'the list is never named to somebody else');
            assert.strictEqual((await t.get(`/watchlists/${id}`)).status, 404);
            assert.strictEqual((await t.get(`/api/v1/watchlists/${id}`)).status, 401, 'the API needs a signed-in caller, as before');
        });

        await check('Anyone with the link reads the page and the API, and cannot edit', async () => {
            const saved = await setShare(id, { audience: 'link' }, kim);
            assert.strictEqual(saved.status, 200, saved.text);
            assert.strictEqual(saved.json().audience, 'link');
            const guest = await t.get(`/watchlists/${id}`);
            assert.strictEqual(guest.status, 200, guest.text);
            assert.ok(guest.text.includes('Semis') && guest.text.includes('ACME'));
            assert.ok(guest.text.includes('Anyone with the link'));
            assert.ok(!guest.text.includes('data-ov-share-sheet'), 'a reader gets no Share sheet');
            assert.ok(!guest.text.includes('action="/watchlists/item"'), 'a reader gets no add form');
            assert.ok(!guest.text.includes('Delete this watchlist'));
            // The API needs a signed-in caller; a member of the link audience then reads it.
            assert.strictEqual((await t.get(`/api/v1/watchlists/${id}`)).status, 401);
            const api = await t.get(`/api/v1/watchlists/${id}`, { as: bo });
            assert.strictEqual(api.status, 200);
            assert.strictEqual(api.json().can_edit, false);
            assert.strictEqual((await t.get(`/api/v1/watchlists/${id}/items/BETA`, { method: 'PUT', as: bo, json: {} })).status, 404);
        });

        await check('Specific people: an editor adds and removes instruments, a viewer only reads, a stranger gets the gate', async () => {
            const saved = await setShare(id, { audience: 'people', members: [{ name: 'bo', role: 'editor' }, { name: 'cy', role: 'viewer' }] }, kim);
            assert.strictEqual(saved.status, 200, saved.text);
            assert.strictEqual(saved.json().audience, 'people');
            const editor = await t.get(`/watchlists/${id}`, { as: bo });
            assert.strictEqual(editor.status, 200, editor.text);
            assert.ok(editor.text.includes('Semis'));
            assert.ok(editor.text.includes('action="/watchlists/item"'), 'Can edit opens the add form');
            assert.ok(!editor.text.includes('Delete this watchlist'), 'only the owner deletes');
            const added = await t.get('/watchlists/item', { as: bo, form: { _csrf: t.csrf(bo), watchlist_id: id, q: 'BETA' } });
            assert.strictEqual(added.status, 303, added.text);
            assert.strictEqual(await t.ctx.store.db.value('SELECT COUNT(*) FROM trade_watchlist_items WHERE watchlist_id = $1', [id]), 2);
            const removed = await t.get('/watchlists/item/remove', { as: bo, form: { _csrf: t.csrf(bo), watchlist_id: id, symbol: 'BETA' } });
            assert.strictEqual(removed.status, 303, removed.text);
            const viewer = await t.get(`/watchlists/${id}`, { as: cy });
            assert.strictEqual(viewer.status, 200);
            assert.ok(!viewer.text.includes('action="/watchlists/item"'), 'Can view cannot edit');
            const refused = await t.get('/watchlists/item', { as: cy, form: { _csrf: t.csrf(cy), watchlist_id: id, q: 'BETA' } });
            assert.strictEqual(refused.status, 303, refused.text);
            assert.ok(/view-only/.test(refused.headers.get('location') || ''), 'a viewer is told the list is read-only');
            assert.strictEqual(await t.ctx.store.db.value('SELECT COUNT(*) FROM trade_watchlist_items WHERE watchlist_id = $1', [id]), 1);
            const stranger = t.network.addUser('di');
            const gate = await t.get(`/watchlists/${id}`, { as: stranger });
            assert.strictEqual(gate.status, 404);
            assert.ok(gate.text.includes('shared with specific people'));
            assert.ok(!gate.text.includes('Semis'), 'the gate never shows the name');
            assert.ok(!gate.text.includes('ACME'), 'the gate never shows an instrument');
            assert.ok(gate.text.includes('data-ov-share-gate'));
            assert.strictEqual((await t.get(`/api/v1/watchlists/${id}`, { as: stranger })).status, 404);
        });

        await check('the default applies to the next list, and "apply to all" moves the existing one', async () => {
            const saved = await t.get('/watchlists/defaults', { as: kim, form: { _csrf: t.csrf(kim), audience: 'link', apply_all: '1' } });
            assert.strictEqual(saved.status, 303, saved.text);
            assert.deepStrictEqual(await audienceRow(id), { audience: 'link' });
            const next = await newList(kim, 'Banks');
            assert.deepStrictEqual(await audienceRow(next), { audience: 'link' });
            const start = await t.get('/watchlists', { as: kim });
            assert.ok(start.text.includes('Who can open a new watchlist'), 'the default is on the product page');
            assert.strictEqual((await t.get(`/watchlists/${next}`)).status, 200, 'the next list follows the default');
        });

        await check('deleting a watchlist takes its share row with it', async () => {
            const gone = await t.get(`/api/v1/watchlists/${id}`, { method: 'DELETE', as: kim });
            assert.strictEqual(gone.status, 200, gone.text);
            assert.strictEqual(await audienceRow(id), null);
        });

        await check('a watchlist is never on a gathered page: not the sitemap, not llms.txt', async () => {
            const sitemap = await t.get('/sitemap.xml');
            assert.strictEqual(sitemap.status, 200);
            assert.ok(!sitemap.text.includes(id));
            const llms = await t.get('/llms.txt');
            assert.ok(!llms.text.includes(id) && !/watchlist/i.test(llms.text.split('\n').slice(0, 30).join('\n')));
        });

        done();
    } finally {
        await t.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
