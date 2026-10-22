/**
 * Website analytics: click capture, duplicate suppression, bot filtering,
 * visitor location and the admin report built from them.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { bootstrapEnv, cleanup, startServer } from "./helpers.mjs";
import { describeDevice, formatLocation, isBotUserAgent, lookupLocation } from "../src/geo.js";

let env;
let api;
let token;

before(async () => {
  env = await bootstrapEnv();
  api = await startServer();
  token = (await api.post("/api/admin/login", { body: { username: env.adminUser, password: env.adminPassword } })).body.token;
});

after(async () => {
  await api?.close();
  await cleanup(env?.dataDir);
});

beforeEach(() => api?.resetLimits());

const PHONE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const track = (body, ua = PHONE_UA) => api.post("/api/analytics/events", { body, headers: { "User-Agent": ua } });
const report = async () => (await api.get("/api/admin/analytics", { token })).body;

describe("IP location and device helpers", () => {
  it("resolves public IPv4 and IPv6 addresses to a city", async () => {
    const v4 = await lookupLocation("8.8.8.8");
    assert.equal(v4.countryCode, "US");
    assert.ok(v4.city);
    const v6 = await lookupLocation("2001:4860:4860::8888");
    assert.ok(v6.country);
    assert.equal((await lookupLocation("::ffff:8.8.8.8")).countryCode, "US");
  });

  it("labels private addresses and formats locations", async () => {
    assert.equal((await lookupLocation("127.0.0.1")).city, "Local network");
    assert.equal(formatLocation({ city: "Kazhakootam", region: "Kerala", country: "India" }), "Kazhakootam, Kerala, India");
    assert.equal(formatLocation({}), "Unknown");
  });

  it("recognises devices and bots", () => {
    assert.deepEqual(describeDevice(PHONE_UA), { device: "Mobile", os: "Android", browser: "Chrome" });
    assert.equal(isBotUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1)"), true);
    assert.equal(isBotUserAgent("Mozilla/5.0 HeadlessChrome/130.0"), true);
    assert.equal(isBotUserAgent(PHONE_UA), false);
  });
});

describe("click tracking", () => {
  it("records a WhatsApp click with page, time, device and location", async () => {
    const res = await track({ eventType: "click", sessionId: "s-wa", visitorId: "v-wa", path: "/contact", label: "Chat on WhatsApp", target: "https://wa.me/918714773304", channel: "whatsapp", placement: "floating_button" });
    assert.equal(res.status, 202);
    assert.equal(res.body.duplicate, false);
    const row = (await report()).clickLog.find((c) => c.visitor === "v-wa");
    assert.equal(row.channel, "whatsapp");
    assert.equal(row.path, "/contact");
    assert.equal(row.device, "Mobile");
    assert.equal(row.location, "Local network");
    assert.ok(Date.parse(row.createdAt));
  });

  it("drops an identical click within two seconds as a duplicate", async () => {
    const click = { eventType: "click", sessionId: "s-dup", visitorId: "v-dup", path: "/", label: "Call now", target: "tel:+918714773304", channel: "phone" };
    assert.equal((await track(click)).body.duplicate, false);
    assert.equal((await track(click)).body.duplicate, true);
    assert.equal((await report()).clickLog.filter((c) => c.visitor === "v-dup").length, 1);
  });

  it("ignores events from bots", async () => {
    const res = await track({ eventType: "click", sessionId: "s-bot", path: "/", label: "x", target: "/x", channel: "navigation" }, "Mozilla/5.0 (compatible; Googlebot/2.1)");
    assert.equal(res.body.ignored, "bot");
    assert.equal((await report()).clickLog.some((c) => c.visitor === "s-bot"), false);
  });

  it("reports total clicks and unique visitors per app, numbering repeats", async () => {
    const base = { eventType: "click", path: "/apply", label: "Email us", target: "mailto:info@asbtraininghub.com", channel: "email" };
    await track({ ...base, sessionId: "s-e1", visitorId: "v-e1" });
    await new Promise((r) => setTimeout(r, 2100));
    await track({ ...base, sessionId: "s-e1", visitorId: "v-e1" });
    await track({ ...base, sessionId: "s-e2", visitorId: "v-e2" });

    const data = await report();
    const email = data.channels.find((c) => c.channel === "email");
    assert.equal(email.total, 3);
    assert.equal(email.unique, 2);
    assert.equal(email.repeats, 1);
    const repeats = data.clickLog.filter((c) => c.visitor === "v-e1").map((c) => c.repeat).sort();
    assert.deepEqual(repeats, [1, 2]);
    assert.ok(data.summary.contactClicks >= 3);
    assert.ok(data.locations.some((l) => l.location === "Local network" && l.contactClicks >= 3));
  });

  it("counts legacy WhatsApp direct_contact events as WhatsApp clicks", async () => {
    await track({ eventType: "direct_contact", sessionId: "s-legacy", channel: "whatsapp", placement: "floating_button", path: "/" });
    const row = (await report()).clickLog.find((c) => c.visitor === "s-legacy");
    assert.equal(row.channel, "whatsapp");
  });

  it("rejects unknown event types", async () => {
    assert.equal((await track({ eventType: "purchase" })).status, 400);
  });
});
