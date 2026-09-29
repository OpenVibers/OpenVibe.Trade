'use strict';
/**
 * Page moves between pages without a reload (plan T11, openvibe-shared 2.2.0 boost): every page the layout
 * renders carries the release marker and the boost script (data-main="#main", the element boost swaps), and
 * the shared navbar's sign-in is a {path} template so it returns to whatever page is showing.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();

    await check('every rendered page carries the ov-boost marker and the boost script with data-main', async () => {
        for (const p of ['/', '/sources', '/does-not-exist']) {
            const r = await t.get(p);
            assert.ok(r.text.includes('<meta name="ov-boost" content="trade@'), `${p}: no ov-boost marker`);
            assert.ok(/<script src="\/shared\/boost\.js\?v=[^"]+" data-main="#main" defer><\/script>/.test(r.text), `${p}: no boost script with data-main`);
            assert.ok(r.text.includes('<main id="main"'), `${p}: main#main missing`);
        }
    });

    await check('the shared navbar signs in with a {path} template (returns to the current page)', async () => {
        const html = (await t.get('/sources')).text;
        assert.ok(html.includes('"loginUrl":"/auth/login?next={path}"'), 'navbar loginUrl is not the {path} template');
        assert.ok(!html.includes('"loginUrl":"/auth/login?next=%2Fsources"'), 'the shared navbar still bakes the current path');
    });

    await t.close();
    done();
})();
