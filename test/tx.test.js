'use strict';
/**
 * store.tx nests: the SDK turns an inner transaction into a SAVEPOINT, so an inner throw rolls back
 * only what the inner transaction wrote and the outer one still commits the rest — while a throw in
 * the outer transaction rolls everything back. Trade relies on this (a domain call wrapped in an
 * inner tx must not undo the caller's own writes). Pinned here with plain key/value rows in
 * trade_sync_state; no production behaviour is exercised beyond the transactions themselves.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const mark = (store, name, value) => store.db.prepare('INSERT INTO trade_sync_state (name, cursor) VALUES (?, ?)').run(name, value);

async function state(t) {
    const rows = await t.ctx.store.db.prepare('SELECT name, cursor FROM trade_sync_state ORDER BY name').all();
    return rows.map((r) => `${r.name}=${r.cursor}`).sort();
}

(async () => {
    const t = await boot();
    const store = t.ctx.store;

    try {
        await check('a transaction that throws rolls back everything it wrote', async () => {
            await assert.rejects(() => store.tx(async () => {
                await mark(store, 'outer-rollback', 1);
                throw new Error('outer boom');
            }), /outer boom/);
            assert.deepStrictEqual(await state(t), [], 'no row survives the outer rollback');
        });

        await check('a nested transaction that throws rolls back only its own writes; the outer commits the rest', async () => {
            await store.tx(async () => {
                await mark(store, 'outer-keeps', 1);
                await mark(store, 'outer-keeps-2', 2);
                await assert.rejects(() => store.tx(async () => {
                    await mark(store, 'inner-lost', 99);
                    throw new Error('inner boom');
                }), /inner boom/, 'the inner throw reaches the caller');
                await mark(store, 'outer-after-inner', 3);
            });
            assert.deepStrictEqual(await state(t), ['outer-after-inner=3', 'outer-keeps-2=2', 'outer-keeps=1'].sort(),
                "only the inner transaction's own write is gone");
        });

        await check('an outer throw after a successful nested transaction still rolls back the nested writes', async () => {
            await assert.rejects(() => store.tx(async () => {
                await store.tx(async () => { await mark(store, 'nested-committed-inside', 7); });
                throw new Error('outer boom 2');
            }), /outer boom 2/);
            assert.deepStrictEqual(await state(t), ['outer-after-inner=3', 'outer-keeps-2=2', 'outer-keeps=1'].sort(),
                'the nested write is not committed by an outer rollback');
        });

        await check('a nested transaction that commits returns its value and joins the outer transaction', async () => {
            const out = await store.tx(async () => {
                const inner = await store.tx(async () => { await mark(store, 'deep', 1); return 'inner-value'; });
                return { inner, outer: 'outer-value' };
            });
            assert.deepStrictEqual(out, { inner: 'inner-value', outer: 'outer-value' });
            assert.ok((await state(t)).includes('deep=1'), 'the nested write is committed with the outer transaction');
        });

        await check('writes before an outer throw are invisible to a fresh reader, and the store is still usable', async () => {
            await assert.rejects(() => store.tx(async () => { await mark(store, 'gone', 5); throw new Error('boom 3'); }));
            assert.ok(!(await state(t)).includes('gone=5'), 'the rolled-back row is gone');
            await store.tx(async () => { await mark(store, 'after-rollback', 6); });
            assert.ok((await state(t)).includes('after-rollback=6'), 'the pool connection is usable again');
        });
    } finally {
        await t.close();
    }

    done();
})().catch((e) => { console.error(e); process.exit(1); });
