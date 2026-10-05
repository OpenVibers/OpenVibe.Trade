# Changelog

## Unreleased

- openvibe-contracts moves to v0.97.0 (pin, lockfile and `node_modules`). All twelve `trade.*` ids are now defined by the release, so `server/auth/capabilities.js` drops its local fallback for proposed ids and sends every check through the library's grant rule; `test/capabilities.test.js` pins that every guarded id is defined and that exact, prefix, denied and unknown ids answer as `capabilities.check()` does. `server/index.js` moves its shutdown onto `openvibe-sdk/service`'s `gracefulStop` (drain with `Connection: close`, then the worker, the outbox and the store; SIGTERM/SIGINT replace the hand-rolled handlers and timer), pinned by the spawn-SIGTERM check in `test/service-kit.test.js`. README and STATUS.json name v0.97.0 and the pinned v0.26.0 SDK.
- Every page is rendered through `openvibe-publishing/layout` (v1.2.0, on `openvibe-shared/shell` v2.6.0): the head, the Frame, the noscript navigation, the footer and its init come from the shared document; Trade keeps its site stylesheet, the disclaimers, the account bar and the "Recently shipped" line. Pins `openvibe-shared` v2.6.0 and `openvibe-publishing` v1.2.0.
