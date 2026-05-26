import { config } from "dotenv";

// Load the test database URL before any test module (which reads
// process.env.DATABASE_URL at import time) is evaluated. `override` makes
// .env.test authoritative even if an ambient DATABASE_URL is exported.
config({ path: ".env.test", override: true });
