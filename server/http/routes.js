'use strict';

/**
 * Route definition with an explicit handler name. Every route Trade serves (outside the shared
 * /auth session layer) is registered through define(), so the route inventory test
 * (test/route-inventory.test.js) can read each path AND a meaningful handler name from the live
 * Express stack and fail the build if either carries order, buy/sell, execution, custody, wallet,
 * escrow, checkout or listing semantics (ADR-025).
 */
function named(name, fn) {
    if (typeof name !== 'string' || !/^[a-z][A-Za-z0-9]+$/.test(name)) throw new TypeError(`handler name "${name}" must be camelCase`);
    Object.defineProperty(fn, 'name', { value: name });
    return fn;
}

/** define(router, 'get', '/path', 'handlerName', ...middleware, handler) */
function define(router, method, path, name, ...handlers) {
    if (!handlers.length) throw new TypeError('a route needs a handler');
    const last = handlers.pop();
    router[method](path, ...handlers, named(name, last));
}

module.exports = { define, named };
