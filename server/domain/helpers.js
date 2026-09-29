'use strict';

/**
 * Trade's small shared helpers. The generic normalisers (folds, keys, amounts, instants, text and
 * decimal parsing, ids) come from the ingest chassis (openvibe-publishing/ingest); only the two
 * things the chassis does not own live here — id generation and the request-invalid error.
 * Nothing here invents a value: a date the caller did not state stays null, never "now".
 */
const { normalize } = require('openvibe-publishing/ingest');
const { ids } = require('openvibe-contracts');
const { ApiError } = require('../http/errors');

const newId = (prefix, now) => `${prefix}_${ids.ulid(now)}`;
const invalid = (detail, code = 'request.invalid') => new ApiError(422, code, detail);

module.exports = { ...normalize, newId, invalid };
