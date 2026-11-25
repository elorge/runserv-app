// backend/src/utils/flags.js — ONE parser for boolean environment flags, used by the startup guard AND the request path, so they can never disagree
// (previously envGuard accepted "TRUE" while the auth middleware only honoured exactly "true").
'use strict';
const isTrue = (v) => String(v ?? '').trim().toLowerCase() === 'true';
/** Startup guard helper: a value that is set but is not a clean true/false (e.g. "yes", "1", "TRUE ") is a configuration mistake. */
const isCanonicalBool = (v) => v === undefined || v === '' || v === 'true' || v === 'false';
module.exports = { isTrue, isCanonicalBool };
