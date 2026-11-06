/**
 * Visitor location from IP address, looked up on this server.
 *
 * Uses the DB-IP "IP to City Lite" database (CC BY 4.0, attribution shown in
 * the admin report) so visitor IPs are never sent to a third-party service.
 * The site is not behind Cloudflare, so the cf-ipcity headers the analytics
 * used to rely on were always empty.
 *
 * Each database (IPv4 ~63 MB, IPv6 ~71 MB) is loaded the first time an
 * address of that family is seen. A small server must not run out of memory
 * for a report detail, so a database is only loaded while the machine has room
 * and is released again after a quiet spell. A visit recorded without a
 * location is filled in from its IP when the report is next built.
 */
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import maxmind from "maxmind";

const require = createRequire(import.meta.url);
const readers = { 4: null, 6: null };
const idleTimers = { 4: null, 6: null };
const cache = new Map();
const CACHE_LIMIT = 5000;
const DATABASE_MB = { 4: 70, 6: 80 };
const IDLE_RELEASE_MS = 15 * 60 * 1000;
// Free memory to leave for the app and nginx after a database has loaded.
const minFreeMb = () => Number(process.env.GEO_MIN_FREE_MB) || 150;

const COUNTRY_NAMES = new Intl.DisplayNames(["en"], { type: "region" });
const countryName = (code) => {
  try {
    return code ? COUNTRY_NAMES.of(code) || code : "";
  } catch {
    return code || "";
  }
};

const releaseWhenIdle = (family) => {
  clearTimeout(idleTimers[family]);
  idleTimers[family] = setTimeout(() => { readers[family] = null; }, IDLE_RELEASE_MS);
  idleTimers[family].unref();
};

const readerFor = (family) => {
  releaseWhenIdle(family);
  if (!readers[family]) {
    if (os.freemem() / 1048576 < DATABASE_MB[family] + minFreeMb()) return null;
    const file = require.resolve(`@ip-location-db/dbip-city-mmdb/dbip-city-ipv${family}.mmdb`);
    readers[family] = maxmind.open(file).catch((error) => {
      readers[family] = null;
      throw error;
    });
  }
  return readers[family];
};

const isPrivate = (ip) =>
  /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip) || ip === "::1" || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip);

/** Returns { city, region, country, countryCode } for an IP; empty strings when unknown. */
export const lookupLocation = async (rawIp) => {
  const empty = { city: "", region: "", country: "", countryCode: "" };
  if (!rawIp) return empty;
  const ip = String(rawIp).replace(/^::ffff:/i, "");
  const family = net.isIP(ip);
  if (!family) return empty;
  if (isPrivate(ip)) return { ...empty, city: "Local network" };
  if (cache.has(ip)) return cache.get(ip);

  let location = empty;
  try {
    const reader = await readerFor(family);
    if (!reader) return empty;
    const record = reader.get(ip);
    if (record) {
      location = {
        city: record.city || "",
        region: record.state1 || "",
        country: countryName(record.country_code),
        countryCode: record.country_code || "",
      };
    }
  } catch (error) {
    console.warn("IP location lookup unavailable:", error.message);
  }

  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(ip, location);
  return location;
};

/** "City, Region, Country" without empty parts. */
export const formatLocation = ({ city, region, country } = {}) =>
  [city, region, country].filter(Boolean).filter((part, i, all) => all.indexOf(part) === i).join(", ") || "Unknown";

/** Coarse device details from a user-agent string. */
export const describeDevice = (userAgent = "") => {
  const ua = String(userAgent);
  const device = /iPad|Tablet/i.test(ua) ? "Tablet" : /Mobi|Android|iPhone/i.test(ua) ? "Mobile" : "Desktop";
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iOS/i.test(ua) ? "iOS" : /Windows/i.test(ua) ? "Windows" : /Mac OS X/i.test(ua) ? "macOS" : /Linux/i.test(ua) ? "Linux" : "Other";
  const browser = /SamsungBrowser/i.test(ua) ? "Samsung Internet" : /Edg\//i.test(ua) ? "Edge" : /OPR\/|Opera/i.test(ua) ? "Opera" : /Chrome\//i.test(ua) ? "Chrome" : /Firefox\//i.test(ua) ? "Firefox" : /Safari\//i.test(ua) ? "Safari" : "Other";
  return { device, os, browser };
};

/** Crawlers, monitors and headless browsers that run JavaScript but are not people. */
export const isBotUserAgent = (userAgent = "") =>
  /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|phantom|selenium|puppeteer|playwright|python|curl|wget|httpclient|java\/|go-http/i.test(String(userAgent));
