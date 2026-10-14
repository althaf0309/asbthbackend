/**
 * Public-form screening with Cloudflare Turnstile enforced.
 *
 * Runs in its own file (and therefore its own process) because the Turnstile
 * secret is read when src/index.js is first imported.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { bootstrapEnv, cleanup, startServer } from "./helpers.mjs";

let env;
let api;
let token;

before(async () => {
  env = await bootstrapEnv();
  process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret";
  api = await startServer();
  token = (
    await api.post("/api/admin/login", {
      body: { username: env.adminUser, password: env.adminPassword },
    })
  ).body.token;
});

after(async () => {
  await api?.close();
  await cleanup(env?.dataDir);
});

beforeEach(() => api?.resetLimits());

const submissions = async () => (await api.get("/api/admin/submissions", { token })).body;

describe("public form screening with Turnstile enforced", () => {
  it("keeps an enquiry that arrives without a Turnstile token, unverified and un-emailed", async () => {
    const res = await api.post("/api/inquiries", {
      body: { name: "Anjali Menon", phone: "9847012345", course: "logistics", message: "Please call about fees" },
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.id, "the held enquiry must be stored");
    assert.equal(res.body.notification, undefined, "unverified enquiries must not receive the email key");

    const stored = (await submissions()).find((s) => s.id === res.body.id);
    assert.equal(stored.verification, "unverified");
    assert.equal(stored.screeningReason, "missing-turnstile");
    assert.equal(stored.phone, "9847012345");
  });

  it("holds applications the same way", async () => {
    const res = await api.post("/api/applications", {
      body: { name: "Rahul Nair", email: "rahul@example.com", phone: "9847099999", course: "warehouse" },
    });
    assert.ok(res.body.id);
    assert.equal((await submissions()).find((s) => s.id === res.body.id).verification, "unverified");
  });

  it("still silently drops a honeypot submission", async () => {
    const before = (await submissions()).length;
    const res = await api.post("/api/inquiries", {
      body: { name: "Bot", phone: "9000000000", website: "http://spam.example" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.id, undefined);
    assert.equal((await submissions()).length, before);
  });
});
