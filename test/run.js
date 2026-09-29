#!/usr/bin/env node
/**
 * Runs every test/*.test.js in its own process and fails if any fails. They use PGlite databases
 * (or, with TRADE_TEST_STORE=pg, the PostgreSQL containers) and in-process mocks of OpenVibe.Network
 * and Sources; none needs the network or a running site.
 *
 *   npm test                 # everything
 *   npm test -- schedule     # only files whose name contains one of the words
 *   npm test -- --strict     # a skipped test fails the run too
 *
 * A test that cannot run something here prints `<label>: skipped (<why>)`: that file is listed with
 * ○ and not counted as passed (openvibe-shared/test-runner).
 */
'use strict';
const { run } = require('openvibe-shared/test-runner');

// VERBOSE=1 also prints every file's output, then the summary again.
run({ dir: __dirname, timeoutMs: 60000, pad: 30, parallel: 1 }).then((r) => {
    if (process.env.VERBOSE) {
        for (const t of r.results) console.log(`\n── ${t.file} ──\n${t.output.trimEnd()}`);
        console.log(`\n${r.summary}`);
    }
    process.exit(r.exitCode);
}, (err) => { console.error(err); process.exit(1); });
