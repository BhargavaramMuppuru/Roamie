/**
 * Load before any application modules so `config/env` parses successfully.
 */
process.env.NODE_ENV = "test";
process.env.PORT = "3000";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/roamie_test";
process.env.LINQ_API_TOKEN = "test-linq-token";
process.env.LINQ_API_BASE_URL = "https://api.linq.test";
process.env.LINQ_FROM_PHONE = "+15555550100";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.OPENAI_MODEL = "gpt-4o-mini";
process.env.LINQ_WEBHOOK_SECRET = "test-webhook-secret";
process.env.LOG_LEVEL = "error";
process.env.TRUST_PROXY = "0";
process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE = "10000";
process.env.RECEIPT_PARSE_ENABLED = "0";
process.env.VOICE_PARSE_ENABLED = "0";
