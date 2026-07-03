/**
 * Safe env defaults so app modules whose import chain reaches `config/index.ts` (logger,
 * event-bus, stores) can be imported in tests without a real .env. MUST be the FIRST import
 * of a test file — ESM evaluates dependencies in declaration order, so this runs before the
 * config schema parses process.env.
 */
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017';
process.env.MONGODB_DB_NAME ??= 'ygg_test_unused';
process.env.JWT_SECRET ??= 'test-jwt-secret-0123456789abcdef!!';
process.env.LOG_LEVEL ??= 'error';
process.env.BIFORESTING_PSK ??= 'test-psk'; // reg_ack/DOWN sends derive the HMAC key from this
