"use strict";
// Source registry for the BI-grade ingestion pipeline.
//
// The allowlist is the governed INPUT to ingestion: only curated, version-
// controlled sources (edited via a reviewed PR) are ever fetched. Each source
// carries the metadata the pipeline needs — sector mapping (network.json keys),
// license class (drives storage/display rules), and a scheduling cadence.
//
// Onboarding a source is a HUMAN-REVIEWED gate: you add/change an entry in
// data/sources.json and open a PR. There is deliberately no auto-discovery.

const fs = require("fs");
const path = require("path");

const LICENSE_CLASSES = ["open", "news-fair-use", "api-restricted", "restricted"];
const SOURCE_TYPES = ["rss", "api", "html"];
const DEFAULT_PATH = path.join(__dirname, "..", "data", "sources.json");

function validateSourcesData(data) {
  if (!data || typeof data !== "object") {
    return { valid: false, errors: ["sources data must be an object"] };
  }
  if (!Array.isArray(data.sources)) {
    return { valid: false, errors: ["'sources' must be an array"] };
  }
  const errors = [];
  const ids = new Set();
  data.sources.forEach((s, i) => {
    const at = `sources[${i}]`;
    if (!s || typeof s !== "object") { errors.push(`${at} must be an object`); return; }
    if (typeof s.id !== "string" || !s.id) errors.push(`${at}.id is required`);
    else if (ids.has(s.id)) errors.push(`${at}.id is a duplicate: ${s.id}`);
    else ids.add(s.id);
    if (typeof s.name !== "string" || !s.name) errors.push(`${at}.name is required`);
    if (!SOURCE_TYPES.includes(s.type)) errors.push(`${at}.type must be one of ${SOURCE_TYPES.join("/")}`);
    if (typeof s.endpoint !== "string" || !/^https?:\/\//i.test(s.endpoint)) {
      errors.push(`${at}.endpoint must be a valid http(s) URL`);
    }
    if (!Array.isArray(s.sectorTags) || s.sectorTags.length === 0) {
      errors.push(`${at}.sectorTags must be a non-empty array`);
    }
    if (!LICENSE_CLASSES.includes(s.licenseClass)) {
      errors.push(`${at}.licenseClass must be one of ${LICENSE_CLASSES.join("/")}`);
    }
    if (typeof s.cadence !== "string" || !s.cadence) errors.push(`${at}.cadence is required`);
    if (typeof s.enabled !== "boolean") errors.push(`${at}.enabled must be a boolean`);
    if (typeof s.trustTier !== "number") errors.push(`${at}.trustTier must be a number`);
  });
  return { valid: errors.length === 0, errors };
}

function getEnabledSources(data) {
  if (!data || !Array.isArray(data.sources)) return [];
  return data.sources.filter((s) => s.enabled !== false);
}

function getSourceById(data, id) {
  if (!data || !Array.isArray(data.sources)) return null;
  return data.sources.find((s) => s.id === id) || null;
}

function bySector(data, sector) {
  if (!data || !Array.isArray(data.sources)) return [];
  return data.sources.filter((s) => Array.isArray(s.sectorTags) && s.sectorTags.includes(sector));
}

function byLicenseClass(data, cls) {
  if (!data || !Array.isArray(data.sources)) return [];
  return data.sources.filter((s) => s.licenseClass === cls);
}

function loadDefaultSources() {
  const raw = fs.readFileSync(DEFAULT_PATH, "utf8");
  const data = JSON.parse(raw);
  const { valid, errors } = validateSourcesData(data);
  if (!valid) throw new Error("Invalid sources.json: " + errors.join("; "));
  return data;
}

module.exports = {
  LICENSE_CLASSES,
  SOURCE_TYPES,
  DEFAULT_PATH,
  validateSourcesData,
  getEnabledSources,
  getSourceById,
  bySector,
  byLicenseClass,
  loadDefaultSources,
};
