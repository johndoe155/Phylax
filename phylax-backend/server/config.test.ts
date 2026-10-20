import { describe, expect, it } from "vitest";
import { isNonRoutableMailHost, isPlaceholderSecret, loadConfig } from "./config.js";

/**
 * The environment rules.
 *
 * The point of these is that a mistake shows up when the server starts, with a message that says what to do,
 * rather than as something strange happening to a person at three in the morning.
 */

const base = {
  NODE_ENV: "production",
  REQUIRE_AUTHENTICATED_ORIGIN_PULLS: "true", CF_ORIGIN_CA_CERT: "/etc/ssl/certs/ca-certificates.crt",
  MAIL_PROVIDER: "disabled", SERVICE_OPERATOR:"Test Operator",SERVICE_CONTACT_EMAIL:"privacy@phylax.test",SERVICE_JURISDICTION:"Test jurisdiction",LEGAL_APPROVED_VERSION:"2026-10-17.2",
  SMS_PROVIDER: "disabled", OPS_TOKEN:"independent-test-ops-token-at-least-32-chars",
  DATABASE_URL: "postgresql://phylax:secret@127.0.0.1:5432/phylax",
  SESSION_SECRET: "a-secret-that-is-definitely-long-enough-to-pass",
  APP_URL: "https://phylax.test",
  RP_ID: "phylax.test",
  // Required in production: the backup receipt is world-readable, so its databaseHash must be an HMAC.
  DATABASE_HASH_KEY: "0f3a9c1e7b5d2468a0c4e8b2d6f0a4c8e2b6d0f4a8c2e6b0d4f8a2c6e0b4d8f2",
  // A From address on a domain that is not an example/test domain (MAIL_FROM is validated now).
  MAIL_FROM: "Phylax <no-reply@phylax.test>",
};

describe("the environment", () => {
  it("refuses production log transports", () => {
    expect(() => loadConfig({ ...base, MAIL_PROVIDER: "log" })).toThrow(/never log/);
    expect(() => loadConfig({ ...base, SMS_PROVIDER: "log" })).toThrow(/never log/);
  });
  it("accepts a correct production environment", () => {
    const config = loadConfig(base);
    expect(config.isProd).toBe(true);
    expect(config.rpId).toBe("phylax.test");
    expect(config.rpOrigin).toBe("https://phylax.test");
    expect(config.allowedOrigins).toEqual(["https://phylax.test"]);
  });

  it("refuses to start without a database", () => {
    const { DATABASE_URL: _databaseUrl, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL is required/);
  });

  it("refuses to start with the development session secret", () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: "dev-only-insecure-secret-change-me-0123456789" })).toThrow(
      /still the development default/,
    );
  });

  it("refuses to start with a short session secret", () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: "too-short" })).toThrow(/at least 32 characters/);
  });

  it("refuses to start with an insecure cookie in production", () => {
    expect(() => loadConfig({ ...base, COOKIE_SECURE: "false" })).toThrow(/COOKIE_SECURE must be true/);
  });

  it("refuses to start with a plain-HTTP address in production", () => {
    expect(() => loadConfig({ ...base, APP_URL: "http://phylax.test" })).toThrow(/must start with https/);
  });

  it("refuses to start when the passkey's domain does not match the site", () => {
    // A subdomain cannot register a passkey for its parent domain, and the browser would refuse every one.
    expect(() => loadConfig({ ...base, RP_ID: "passkeys.example.com" })).toThrow(/does not match APP_URL/);
  });

  it("accepts a subdomain of the relying party id", () => {
    expect(() =>
      loadConfig({ ...base, APP_URL: "https://app.phylax.test", RP_ID: "phylax.test" }),
    ).not.toThrow();
  });

  it("refuses to start when a mail provider is chosen but its key is not set", () => {
    expect(() => loadConfig({ ...base, MAIL_PROVIDER: "resend" })).toThrow(/RESEND_API_KEY/);
    expect(() => loadConfig({ ...base, MAIL_PROVIDER: "postmark" })).toThrow(/POSTMARK_API_KEY/);
    expect(() => loadConfig({ ...base, MAIL_PROVIDER: "smtp" })).toThrow(/SMTP_HOST/);
    expect(() => loadConfig({ ...base, SMS_PROVIDER: "twilio" })).toThrow(/TWILIO_ACCOUNT_SID/);
    expect(() => loadConfig({ ...base, SMS_PROVIDER: "webhook" })).toThrow(/SMS_WEBHOOK_URL/);
  });

  it("refuses to start with a provider the code does not know", () => {
    expect(() => loadConfig({ ...base, MAIL_PROVIDER: "carrier-pigeon" })).toThrow();
  });

  it("allows a database-less development environment", () => {
    const { DATABASE_URL: _databaseUrl, ...rest } = base;
    const config = loadConfig({ ...rest, NODE_ENV: "development" });
    expect(config.DATABASE_URL).toBeUndefined();
    expect(config.isProd).toBe(false);
  });

  it("derives the passkey's domain from the address when it is not set", () => {
    const { RP_ID: _rpId, ...rest } = base;
    const config = loadConfig(rest);
    expect(config.rpId).toBe("phylax.test");
  });

  it("ignores a trailing slash on the address", () => {
    const config = loadConfig({ ...base, APP_URL: "https://phylax.test/" });
    expect(config.APP_URL).toBe("https://phylax.test/");
    expect(config.rpOrigin).toBe("https://phylax.test");
  });

  it("reads the booleans the way a shell would write them", () => {
    for (const yes of ["1", "true", "TRUE", "yes", "on"]) {
      expect(loadConfig({ ...base, TRUST_PROXY: yes }).TRUST_PROXY).toBe(true);
    }
    for (const no of ["0", "false", "FALSE", "no", "off", ""]) {
      expect(loadConfig({ ...base, TRUST_PROXY: no }).TRUST_PROXY).toBe(false);
    }
  });

  it("keeps the numbers inside their allowed range", () => {
    expect(() => loadConfig({ ...base, PORT: "70000" })).toThrow();
    expect(() => loadConfig({ ...base, SESSION_TTL_DAYS: "0" })).toThrow();
    expect(loadConfig({ ...base, PORT: "8080" }).PORT).toBe(8080);
  });

  // ---- placeholder secrets ---------------------------------------------------------------------------
  //
  // `.env.example` shipped `SESSION_SECRET=CHANGE_ME_to_a_long_random_string_at_least_32_characters` — 56
  // characters, so it passed a length rule, and it is in the public repository. A deployment that copied the
  // example and missed one line ran in production with a secret anybody could read.
  describe("placeholder secrets", () => {
    it("refuses the literal value .env.example ships", () => {
      expect(() => loadConfig({ ...base, SESSION_SECRET: "CHANGE_ME_to_a_long_random_string_at_least_32_characters" })).toThrow(/placeholder/);
    });
    it("refuses the shapes that say a human has not been here yet", () => {
      for (const secret of [
        "changeme-changeme-changeme-changeme-1234567890",
        "your-secret-key-here-and-it-is-long-enough-1234",
        "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "placeholder-placeholder-placeholder-placehold",
        "TODO-replace-this-before-going-live-123456789",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // one repeated character: no entropy
        "1234567890123456789012345678901234567890", // digits only, under 64 characters
      ]) {
        expect(isPlaceholderSecret(secret), secret).toBe(true);
      }
    });
    it("accepts a real generated secret", () => {
      expect(isPlaceholderSecret("0f3a9c1e7b5d2468a0c4e8b2d6f0a4c8e2b6d0f4a8c2e6b0d4f8a2c6e0b4d8f2")).toBe(false);
      expect(() => loadConfig({ ...base, SESSION_SECRET: "0f3a9c1e7b5d2468a0c4e8b2d6f0a4c8e2b6d0f4a8c2e6b0d4f8a2c6e0b4d8f2" })).not.toThrow();
    });
    it("accepts the exact output of the generator the file tells operators to run", () => {
      // `openssl rand -hex 32` is 64 LOWERCASE HEXADECIMAL characters — a single character class. A diversity
      // rule would reject the documented command's own output, so there is deliberately no such rule.
      const hex = "9f2c41ab7d05e83c6b1a94f0d72e5c8b3a61f9047d2c85eb1a60f3497c2d85eb";
      expect(isPlaceholderSecret(hex)).toBe(false);
      expect(() => loadConfig({ ...base, SESSION_SECRET: hex })).not.toThrow();
    });
    it("checks the other secrets the same way", () => {
      expect(() => loadConfig({ ...base, OPS_TOKEN: "CHANGE_ME_ops_token_that_is_at_least_32_characters_long" })).toThrow(/placeholder/);
      expect(() => loadConfig({ ...base, DATABASE_HASH_KEY: "CHANGE_ME_database_hash_key_0123456789abcdef" })).toThrow(/placeholder/);
      expect(() => loadConfig({ ...base, IDENTIFIER_HASH_KEY: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" })).toThrow(/placeholder/);
    });
    it("does not apply the placeholder rule outside production", () => {
      expect(() => loadConfig({ ...base, NODE_ENV: "development", SESSION_SECRET: "CHANGE_ME_to_a_long_random_string_at_least_32_characters" })).not.toThrow();
    });
  });

  // ---- the backup receipt hash key ---------------------------------------------------------------------
  it("refuses production without DATABASE_HASH_KEY", () => {
    const { DATABASE_HASH_KEY: _key, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/DATABASE_HASH_KEY is required in production/);
  });

  // ---- MAIL_FROM ----------------------------------------------------------------------------------------
  // MAIL_FROM is only validated when something will actually be sent: `disabled` never mails anybody, so a
  // placeholder From address is harmless and refusing to boot over it would be noise.
  describe("MAIL_FROM", () => {
    const sending = { ...base, MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_a_real_key", RESEND_WEBHOOK_SECRET: "whsec_a_real_callback_secret" };
    it("refuses a value that is not a From header", () => {
      expect(() => loadConfig({ ...sending, MAIL_FROM: "not an address" })).toThrow(/not a valid From header/);
      expect(() => loadConfig({ ...sending, MAIL_FROM: "Phylax <no-reply@" })).toThrow(/not a valid From header/);
      expect(() => loadConfig({ ...sending, MAIL_REPLY_TO: "nope" })).toThrow(/MAIL_REPLY_TO/);
    });
    it("accepts both shapes a provider will relay", () => {
      expect(loadConfig({ ...sending, MAIL_FROM: "Phylax <alerts@phylax.test>" }).mailFromAddress).toBe("alerts@phylax.test");
      expect(loadConfig({ ...sending, MAIL_FROM: "alerts@phylax.test" }).mailFromAddress).toBe("alerts@phylax.test");
    });
    it("refuses an example or test domain in production", () => {
      // provision.sh used to write exactly this, so a provisioned host booted cleanly and then failed on the
      // first real send: no provider relays mail from a domain you do not own.
      expect(() => loadConfig({ ...sending, MAIL_FROM: "Phylax <no-reply@phylax.example.com>" })).toThrow(/example\/test domain/);
      expect(() => loadConfig({ ...sending, MAIL_FROM: "no-reply@mail.localhost" })).toThrow(/example\/test domain/);
      expect(() => loadConfig({ ...sending, MAIL_FROM: "no-reply@phylax.test.invalid" })).toThrow(/example\/test domain/);
      // A bare single-label host fails the From-header shape rule first, which is the more accurate complaint.
      expect(() => loadConfig({ ...sending, MAIL_FROM: "no-reply@localhost" })).toThrow(/not a valid From header/);
      expect(isNonRoutableMailHost("localhost")).toBe(true);
      expect(isNonRoutableMailHost("mail.localhost")).toBe(true);
      expect(isNonRoutableMailHost("phylax.example.com")).toBe(true);
      expect(isNonRoutableMailHost("mail.phylax.io")).toBe(false);
      // `.test` is reserved too, but it is the conventional fixture domain and refusing it would fire on every
      // development and CI environment.
      expect(isNonRoutableMailHost("phylax.test")).toBe(false);
    });
    it("accepts a routable domain, including the conventional .test fixture domain", () => {
      expect(() => loadConfig({ ...sending, MAIL_FROM: "alerts@phylax.test" })).not.toThrow();
      expect(() => loadConfig({ ...sending, MAIL_FROM: "Phylax <alerts@mail.phylax.io>" })).not.toThrow();
    });
    it("allows an example domain while developing", () => {
      expect(() => loadConfig({ ...sending, NODE_ENV: "development", MAIL_FROM: "Phylax <no-reply@phylax.example.com>" })).not.toThrow();
    });
    it("does not check it at all when no mail will be sent", () => {
      expect(() => loadConfig({ ...base, MAIL_PROVIDER: "disabled", MAIL_FROM: "whatever" })).not.toThrow();
    });
  });

  // ---- SMTP ---------------------------------------------------------------------------------------------
  describe("SMTP", () => {
    const smtp = { ...base, MAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.relay.test", SMTP_USER: "u", SMTP_PASSWORD: "p" };
    it("no longer demands a delivery callback that no SMTP relay provides", () => {
      // This was the reason SMTP was unusable in production: SMTP_WEBHOOK_TOKEN is not a thing a relay sends.
      expect(() => loadConfig({ ...smtp, MAIL_DELIVERY_EVIDENCE: "probe" })).not.toThrow();
      expect(() => loadConfig(smtp)).toThrow(/MAIL_DELIVERY_EVIDENCE=probe/);
    });
    it("accepts the callback mode when the deployment really does have one", () => {
      expect(() => loadConfig({ ...smtp, SMTP_WEBHOOK_TOKEN: "a-real-relay-callback-token" })).not.toThrow();
    });
    it("refuses to send in clear text", () => {
      expect(() => loadConfig({ ...smtp, MAIL_DELIVERY_EVIDENCE: "probe", SMTP_SECURE: "false", SMTP_REQUIRE_TLS: "false" })).toThrow(/clear text/);
    });
    it("requires TLS by default", () => {
      expect(loadConfig({ ...smtp, MAIL_DELIVERY_EVIDENCE: "probe" }).SMTP_REQUIRE_TLS).toBe(true);
    });
  });

  // ---- the identifier key --------------------------------------------------------------------------------
  it("keys recipient identifiers off SESSION_SECRET unless told otherwise", () => {
    expect(loadConfig(base).identifierHashKey).toBe(base.SESSION_SECRET);
    const rotated = loadConfig({ ...base, IDENTIFIER_HASH_KEY: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809" });
    expect(rotated.identifierHashKey).not.toBe(base.SESSION_SECRET);
    // Previous keys are for lookups only, and the current key is never duplicated into that list.
    const withPrevious = loadConfig({
      ...base,
      IDENTIFIER_HASH_KEY: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
      IDENTIFIER_HASH_PREVIOUS_KEYS: `${base.SESSION_SECRET},1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809,old-key`,
    });
    expect(withPrevious.identifierHashPreviousKeys).toEqual(["old-key"]);
  });

  // ---- sessions -------------------------------------------------------------------------------------------
  it("refuses an idle timeout that could never fire", () => {
    expect(() => loadConfig({ ...base, SESSION_TTL_DAYS: "1", SESSION_IDLE_TIMEOUT_MINUTES: "2880" })).toThrow(/never fire/);
    expect(loadConfig({ ...base, SESSION_IDLE_TIMEOUT_MINUTES: "60" }).SESSION_IDLE_TIMEOUT_MINUTES).toBe(60);
  });

  // ---- the lock pool ----------------------------------------------------------------------------------------
  it("refuses a lock pool smaller than the query pool", () => {
    // Advisory locks are session-scoped: a held lock pins a connection for the whole operation, so sizing this
    // pool below the query pool makes starvation the normal case.
    expect(() => loadConfig({ ...base, DATABASE_POOL_MAX: "10", DATABASE_LOCK_POOL_MAX: "8" })).toThrow(/at least DATABASE_POOL_MAX/);
  });

  // ---- Turnstile ----------------------------------------------------------------------------------------------
  it("refuses a Turnstile secret with no site key", () => {
    expect(() => loadConfig({ ...base, TURNSTILE_SECRET_KEY: "0x4AAAAAAAreallylongsecretkeyvalue1234567890" })).toThrow(/TURNSTILE_SITE_KEY/);
    expect(() => loadConfig({ ...base, TURNSTILE_SECRET_KEY: "0x4AAAAAAAreallylongsecretkeyvalue1234567890", TURNSTILE_SITE_KEY: "0x4AAAAAAAsitekey" })).not.toThrow();
  });
});
