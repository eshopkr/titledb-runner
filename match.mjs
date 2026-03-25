#!/usr/bin/env bun
/**
 * Nintendo Switch Title Matcher
 * Matches KR eShop titles against all other regions using titledb data.
 * See MATCHING_STRATEGY.md for detailed strategy documentation.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(import.meta.dirname, "data", "titledb-master");
const OUT_DIR = join(import.meta.dirname, "output");

const MIN_NAME_LENGTH = 4; // Minimum normalized name length for name-based matching
const DATE_THRESHOLD_DAYS = 730; // Max release date difference for confirmation (2 years)
const SIZE_THRESHOLD_PCT = 20; // Max size difference percentage for confirmation
const SIZE_REJECT_PCT = 50; // Size difference above this = definite false positive
const MIN_SIZE_BYTES = 10 * 1024 * 1024; // Minimum size (10MB) to use size comparison
const PHASH_THRESHOLD_PCT = 5; // Max pHash hamming distance percentage for icon matching
const PHASH_BITS = 64; // aHash bit length
const PHASH_MAX_DIST = Math.floor(PHASH_BITS * PHASH_THRESHOLD_PCT / 100); // = 3

// ─── Publisher alias mapping ─────────────────────────────────────────
// Groups of known same-company publisher names across regions/languages.
// Only includes confirmed same-entity localizations — NOT different distributors.
// When adding new aliases, verify they are the SAME legal entity or subsidiary.
const PUBLISHER_ALIASES = [
  ["CAPCOM", "カプコン", "CAPCOM Europe", "CAPCOM U.S.A."],
  ["Bethesda", "ベセスダ・ソフトワークス", "Bethesda Softworks"],
  ["KOEI TECMO GAMES", "KOEI TECMO AMERICA", "KOEI TECMO EUROPE", "コーエーテクモゲームス"],
  ["WB Games", "ワーナー", "Warner Bros. Interactive Entertainment"],
  ["BANDAI NAMCO Entertainment", "BANDAI NAMCO Entertainment Asia", "バンダイナムコエンターテインメント", "BANDAI NAMCO Entertainment Inc."],
  ["Clouded Leopard Entertainment", "シーエフケー", "CFK"],
  ["Marvelous Entertainment", "Marvelous (XSEED)", "Marvelous Europe", "マーベラス"],
  ["Nintendo", "任天堂", "腾讯游戏"],
  ["SQUARE ENIX", "スクウェア・エニックス", "SQUARE ENIX CO., LTD."],
  ["Spike Chunsoft", "スパイク・チュンソフト"],
  ["SEGA", "セガ"],
  ["LEVEL5", "レベルファイブ"],
  ["Konami", "KONAMI", "コナミ"],
  ["Ubisoft", "ユービーアイソフト"],
  ["505 Games", "505 Games S.p.A."],
  ["NIS America", "日本一ソフトウェア", "Nippon Ichi Software"],
];

// Build a normalized publisher → alias group ID map
const publisherAliasMap = new Map();
for (let i = 0; i < PUBLISHER_ALIASES.length; i++) {
  for (const name of PUBLISHER_ALIASES[i]) {
    publisherAliasMap.set(normalizeName(name), i);
  }
}

// ─── Title ID type classification ────────────────────────────────────
// Nintendo Switch title ID (16 hex chars): last 3 hex digits determine type
//   0x000 = base application
//   0x800 = patch/update
//   0x001–0x7FF = add-on content (DLC)

function classifyTitleId(id) {
  if (!id) return "no-id";
  const last3 = parseInt(id.slice(-3), 16);
  if (last3 === 0) return "base";
  if (last3 === 0x800) return "update";
  return "dlc";
}

function isBaseGame(id) {
  const type = classifyTitleId(id);
  return type === "base" || type === "no-id";
}

// ─── Load region files ───────────────────────────────────────────────

function loadRegionFiles() {
  const files = readdirSync(DATA_DIR).filter(
    (f) => /^[A-Z]{2}\.[a-z]{2}\.json$/.test(f) && f !== "KR.ko.json"
  );
  const regions = {};
  for (const f of files) {
    const region = f.split(".")[0];
    const data = JSON.parse(readFileSync(join(DATA_DIR, f), "utf8"));
    if (!regions[region]) regions[region] = {};
    for (const [nsuId, entry] of Object.entries(data)) {
      if (!regions[region][nsuId]) {
        regions[region][nsuId] = entry;
      }
    }
  }
  return regions;
}

// ─── Build lookup indexes ────────────────────────────────────────────

function buildTitleIdIndex(regionData) {
  const index = {};
  for (const [region, entries] of Object.entries(regionData)) {
    for (const [nsuId, entry] of Object.entries(entries)) {
      if (!entry.id) continue;
      const tid = entry.id.toUpperCase();
      if (!index[tid]) index[tid] = [];
      index[tid].push({ region, nsuId, entry });
    }
  }
  return index;
}

function buildNameIndex(regionData) {
  const index = {};
  for (const [region, entries] of Object.entries(regionData)) {
    for (const [nsuId, entry] of Object.entries(entries)) {
      if (!entry.name) continue;
      const norm = normalizeName(entry.name);
      if (!norm || norm.length < MIN_NAME_LENGTH) continue;
      if (!index[norm]) index[norm] = [];
      index[norm].push({ region, nsuId, entry });
    }
  }
  return index;
}

// ─── Name normalization ──────────────────────────────────────────────

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/[™®©℠]+/g, "")
    .replace(/\s*[:\-–—]\s*/g, " ")
    .replace(/[''ʼ`]/g, "'")
    .replace(/[""]/g, '"')
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\s'"&+!?.]/g, "")
    .trim();
}

// ─── Confirmation signals ────────────────────────────────────────────

function publisherMatch(pubA, pubB) {
  if (!pubA || !pubB) return false;
  const normA = normalizeName(pubA);
  const normB = normalizeName(pubB);
  if (!normA || !normB) return false;
  // Exact match
  if (normA === normB) return true;
  // Alias match
  const aliasA = publisherAliasMap.get(normA);
  const aliasB = publisherAliasMap.get(normB);
  if (aliasA !== undefined && aliasA === aliasB) return true;
  return false;
}

function releaseDateClose(dateA, dateB) {
  if (!dateA || !dateB) return false;
  const parse = (d) => {
    if (typeof d === "number") {
      const s = String(d);
      return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
    }
    return new Date(d);
  };
  const a = parse(dateA);
  const b = parse(dateB);
  if (isNaN(a) || isNaN(b)) return false;
  const diffDays = Math.abs(a - b) / (1000 * 60 * 60 * 24);
  return diffDays <= DATE_THRESHOLD_DAYS;
}

function sizeClose(sizeA, sizeB) {
  if (!sizeA || !sizeB) return null; // null = not comparable
  if (sizeA < MIN_SIZE_BYTES || sizeB < MIN_SIZE_BYTES) return null;
  const pct = Math.abs(sizeA - sizeB) / Math.max(sizeA, sizeB) * 100;
  return pct;
}

// Size rejection works even for small files — catches DLC stub vs full game
function sizeDivergent(sizeA, sizeB) {
  if (!sizeA || !sizeB) return false;
  const pct = Math.abs(sizeA - sizeB) / Math.max(sizeA, sizeB) * 100;
  return pct > SIZE_REJECT_PCT;
}

// ─── pHash icon matching ─────────────────────────────────────────────
// Loads pre-built pHash TSV databases (no external dependencies).
// TSV format: nsuId\ttitleId\taHash\tpHash

function loadPHashDb(filepath) {
  try {
    const content = readFileSync(filepath, "utf8").trim();
    if (!content) return [];
    return content.split("\n").map((line) => {
      const [nsuId, id, aHash, pHash] = line.split("\t");
      return { nsuId, id: id || null, aHash: BigInt("0x" + aHash), pHash: BigInt("0x" + pHash) };
    });
  } catch {
    return []; // pHash DB not available — skip silently
  }
}

function hammingDistance(a, b) {
  let xor = a ^ b;
  let dist = 0;
  while (xor > 0n) {
    dist += Number(xor & 1n);
    xor >>= 1n;
  }
  return dist;
}

function findPHashMatch(krAHash, usDb) {
  let bestDist = PHASH_MAX_DIST + 1;
  let bestEntry = null;
  for (const entry of usDb) {
    const dist = hammingDistance(krAHash, entry.aHash);
    if (dist < bestDist) {
      bestDist = dist;
      bestEntry = entry;
      if (dist === 0) break; // perfect match
    }
  }
  return bestDist <= PHASH_MAX_DIST ? { entry: bestEntry, dist: bestDist } : null;
}

// ─── Matching ────────────────────────────────────────────────────────

function matchAll(krData, regionData) {
  const titleIdIndex = buildTitleIdIndex(regionData);
  const nameIndex = buildNameIndex(regionData);

  // Load pHash databases for icon-based matching fallback
  const krPHashDb = loadPHashDb(join(import.meta.dirname, "phash-kr.tsv"));
  const usPHashDb = loadPHashDb(join(import.meta.dirname, "phash-us.tsv"));
  const krPHashMap = new Map(); // nsuId → {aHash, pHash}
  for (const entry of krPHashDb) krPHashMap.set(entry.nsuId, entry);

  const matched = {};
  const review = {};
  let idMatchCount = 0;
  let nameMatchCount = 0;
  let sizeMatchCount = 0;
  let aliasMatchCount = 0;
  let phashMatchCount = 0;

  for (const [krNsuId, krEntry] of Object.entries(krData)) {
    const regionMatches = {};

    // Strategy 1: Title ID exact match
    if (krEntry.id) {
      const tid = krEntry.id.toUpperCase();
      const hits = titleIdIndex[tid];
      if (hits) {
        for (const hit of hits) {
          if (
            !regionMatches[hit.region] ||
            hit.nsuId === krNsuId
          ) {
            regionMatches[hit.region] = {
              nsuId: hit.nsuId,
              id: hit.entry.id,
            };
          }
        }
      }
    }

    // Strategy 2: Name match with confirmation signals
    if (krEntry.name) {
      const krNorm = normalizeName(krEntry.name);
      if (krNorm && krNorm.length >= MIN_NAME_LENGTH) {
        const exactHits = nameIndex[krNorm];
        if (exactHits) {
          for (const hit of exactHits) {
            if (regionMatches[hit.region]) continue;
            if (hit.entry.id && krEntry.id && hit.entry.id.toUpperCase() !== krEntry.id.toUpperCase()) {
              // Reject cross-type matches (e.g., base game vs DLC)
              const krType = classifyTitleId(krEntry.id);
              const hitType = classifyTitleId(hit.entry.id);
              if (krType !== hitType) continue;
              // Check size first — reject obvious false positives early
              if (sizeDivergent(krEntry.size, hit.entry.size)) {
                continue; // Definite false positive — skip entirely
              }
              const sizePct = sizeClose(krEntry.size, hit.entry.size);

              const pubOk = publisherMatch(krEntry.publisher, hit.entry.publisher);
              const dateOk = releaseDateClose(krEntry.releaseDate, hit.entry.releaseDate);
              const sizeOk = sizePct !== null && sizePct <= SIZE_THRESHOLD_PCT;

              if (pubOk || dateOk || sizeOk) {
                let matchType = "name+";
                if (pubOk) matchType += "pub";
                else if (dateOk) matchType += "date";
                else matchType += "size";
                regionMatches[hit.region] = {
                  nsuId: hit.nsuId,
                  id: hit.entry.id,
                  matchType,
                };
                nameMatchCount++;
                if (sizeOk && !pubOk && !dateOk) sizeMatchCount++;
                if (pubOk && publisherAliasMap.has(normalizeName(krEntry.publisher || ""))) aliasMatchCount++;
              } else {
                // Determine why confirmation failed
                const reasons = [];
                const krPubNorm = krEntry.publisher ? normalizeName(krEntry.publisher) : null;
                const hitPubNorm = hit.entry.publisher ? normalizeName(hit.entry.publisher) : null;
                if (!krPubNorm || !hitPubNorm) {
                  reasons.push("publisher_not_comparable");
                } else {
                  reasons.push("publisher_mismatch");
                }
                if (!krEntry.releaseDate || !hit.entry.releaseDate) {
                  reasons.push("date_unavailable");
                } else {
                  reasons.push("date_too_far");
                }
                if (sizePct === null) {
                  reasons.push("size_not_comparable");
                } else {
                  reasons.push(`size_diff_${Math.round(sizePct)}pct`);
                }

                if (!review[krNsuId]) {
                  review[krNsuId] = {
                    name: krEntry.name,
                    id: krEntry.id,
                    publisher: krEntry.publisher || null,
                    releaseDate: krEntry.releaseDate || null,
                    size: krEntry.size || null,
                    bannerUrl: krEntry.bannerUrl || null,
                    iconUrl: krEntry.iconUrl || null,
                    candidates: [],
                  };
                }
                review[krNsuId].candidates.push({
                  region: hit.region,
                  nsuId: hit.nsuId,
                  id: hit.entry.id,
                  name: hit.entry.name,
                  publisher: hit.entry.publisher,
                  releaseDate: hit.entry.releaseDate,
                  size: hit.entry.size || null,
                  bannerUrl: hit.entry.bannerUrl || null,
                  iconUrl: hit.entry.iconUrl || null,
                  reason: reasons.join("+"),
                });
              }
            } else if (!hit.entry.id && !krEntry.id) {
              const pubOk = publisherMatch(krEntry.publisher, hit.entry.publisher);
              if (pubOk) {
                regionMatches[hit.region] = {
                  nsuId: hit.nsuId,
                  id: hit.entry.id || null,
                  matchType: "name+publisher",
                };
                nameMatchCount++;
              }
            }
          }
        }
      }
    }

    if (Object.keys(regionMatches).length > 0) {
      matched[krNsuId] = regionMatches;
      if (Object.values(regionMatches).some((m) => !m.matchType)) {
        idMatchCount++;
      }
    }
  }

  // Strategy 3: Promote single-candidate review entries with similar size
  const promoted = [];
  for (const [krNsuId, item] of Object.entries(review)) {
    const krEntry = krData[krNsuId];
    // Group candidates by unique titleId
    const titleIds = new Set(item.candidates.map((c) => c.id));
    if (titleIds.size !== 1) continue;

    // Check if size is similar for first candidate
    const c = item.candidates[0];
    const sizePct = sizeClose(krEntry.size, c.size);
    if (sizePct === null || sizePct > SIZE_THRESHOLD_PCT) continue;

    // Promote: move all candidates to matched
    if (!matched[krNsuId]) matched[krNsuId] = {};
    for (const cand of item.candidates) {
      if (!matched[krNsuId][cand.region]) {
        matched[krNsuId][cand.region] = {
          nsuId: cand.nsuId,
          id: cand.id,
          matchType: "name+size+single",
        };
        nameMatchCount++;
        sizeMatchCount++;
      }
    }
    promoted.push(krNsuId);
  }
  for (const nsuId of promoted) delete review[nsuId];

  // Strategy 3b: Fallback promotion for single-candidate entries with
  // non-generic names and moderate size similarity (<50%, no 10MB minimum)
  let fallbackCount = 0;
  const promotedFallback = [];
  for (const [krNsuId, item] of Object.entries(review)) {
    const krEntry = krData[krNsuId];
    const titleIds = new Set(item.candidates.map((c) => c.id));
    if (titleIds.size !== 1) continue;

    // Normalized name must be non-generic: 8+ chars and not pure numbers
    const krNorm = normalizeName(krEntry.name || "");
    if (krNorm.length < 8) continue;
    if (/^\d+$/.test(krNorm)) continue;

    // Size difference < 50% (raw percentage, no 10MB minimum)
    const c = item.candidates[0];
    if (!krEntry.size || !c.size) continue;
    const pct = Math.abs(krEntry.size - c.size) / Math.max(krEntry.size, c.size) * 100;
    if (pct >= SIZE_REJECT_PCT) continue;

    if (!matched[krNsuId]) matched[krNsuId] = {};
    for (const cand of item.candidates) {
      if (!matched[krNsuId][cand.region]) {
        matched[krNsuId][cand.region] = {
          nsuId: cand.nsuId,
          id: cand.id,
          matchType: "name+size+fallback",
        };
        nameMatchCount++;
      }
    }
    fallbackCount++;
    promotedFallback.push(krNsuId);
  }
  for (const nsuId of promotedFallback) delete review[nsuId];

  // Strategy 4: pHash icon matching — matches KR entries against US entries
  // by comparing pre-computed perceptual hashes of icon images.
  // Only applies to entries not already matched to US region.
  if (usPHashDb.length > 0 && krPHashMap.size > 0) {
    for (const [krNsuId, krEntry] of Object.entries(krData)) {
      // Skip if already matched to US
      if (matched[krNsuId]?.US) continue;
      // Look up KR pHash
      const krHash = krPHashMap.get(krNsuId);
      if (!krHash) continue;
      // Content type filter: only match same type
      const krType = classifyTitleId(krEntry.id);
      const result = findPHashMatch(krHash.aHash, usPHashDb);
      if (!result) continue;
      const usEntry = result.entry;
      const usType = classifyTitleId(usEntry.id);
      if (krType !== usType) continue;
      // Add US match
      if (!matched[krNsuId]) matched[krNsuId] = {};
      matched[krNsuId].US = {
        nsuId: usEntry.nsuId,
        id: usEntry.id,
        matchType: `phash+dist${result.dist}`,
      };
      phashMatchCount++;
      // Remove from review if present
      if (review[krNsuId]) delete review[krNsuId];
    }
  }

  return { matched, review, idMatchCount, nameMatchCount, sizeMatchCount, aliasMatchCount, fallbackCount, phashMatchCount };
}

// ─── Output ──────────────────────────────────────────────────────────

// Convert flat region→{nsuId, id} map into grouped titleIds structure:
// { titleId: { eshopId: [region, ...], ... }, ... }
function buildTitleIds(regionMatches) {
  const titleIds = {};
  for (const [region, m] of Object.entries(regionMatches)) {
    const tid = m.id || null;
    const eid = m.nsuId;
    const key = tid || "__no_id__";
    if (!titleIds[key]) titleIds[key] = {};
    if (!titleIds[key][eid]) titleIds[key][eid] = [];
    titleIds[key][eid].push(region);
  }
  // Sort region arrays for consistency
  for (const tidEntries of Object.values(titleIds)) {
    for (const eid of Object.keys(tidEntries)) {
      tidEntries[eid].sort();
    }
  }
  return titleIds;
}

// Group review candidates by titleId → eshopId, preserving metadata
function buildReviewCandidates(candidates) {
  const grouped = {};
  for (const c of candidates) {
    const tid = c.id || "__no_id__";
    const eid = c.nsuId;
    if (!grouped[tid]) grouped[tid] = {};
    if (!grouped[tid][eid]) {
      grouped[tid][eid] = {
        regions: [],
        name: c.name,
        publisher: c.publisher || null,
        releaseDate: c.releaseDate || null,
        size: c.size || null,
        bannerUrl: c.bannerUrl || null,
        iconUrl: c.iconUrl || null,
        reason: c.reason || null,
      };
    }
    grouped[tid][eid].regions.push(c.region);
  }
  for (const tidEntries of Object.values(grouped)) {
    for (const entry of Object.values(tidEntries)) {
      entry.regions.sort();
    }
  }
  return grouped;
}

// ─── HTML helpers ─────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatSize(bytes) {
  if (!bytes) return "N/A";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function writeOutputs(krData, matched, review, stats) {
  mkdirSync(OUT_DIR, { recursive: true });

  // KR.ko.global.json — full enriched data with region fix + titleIds
  const globalOut = {};
  for (const [nsuId, entry] of Object.entries(krData)) {
    globalOut[nsuId] = { ...entry };
    if (globalOut[nsuId].region == null) {
      globalOut[nsuId].region = "KR";
    }
    if (matched[nsuId]) {
      globalOut[nsuId].titleIds = buildTitleIds(matched[nsuId]);
    }
  }

  // KR.ko.match.json — lightweight titleIds mapping only
  const matchOut = {};
  for (const [nsuId, regionMatches] of Object.entries(matched)) {
    matchOut[nsuId] = buildTitleIds(regionMatches);
  }

  // KR.ko.base.json — base games only (title ID suffix 000 or no ID)
  const baseOut = {};
  for (const [nsuId, entry] of Object.entries(globalOut)) {
    if (isBaseGame(entry.id)) {
      baseOut[nsuId] = entry;
    }
  }

  // KR.ko.extra.json — DLC and updates only
  const extraOut = {};
  for (const [nsuId, entry] of Object.entries(globalOut)) {
    if (!isBaseGame(entry.id)) {
      extraOut[nsuId] = entry;
    }
  }

  // KR.ko.review.json — grouped candidates with KR fields for comparison
  const reviewOut = {};
  for (const [nsuId, item] of Object.entries(review)) {
    reviewOut[nsuId] = {
      name: item.name,
      id: item.id,
      publisher: item.publisher,
      releaseDate: item.releaseDate,
      size: item.size,
      candidates: buildReviewCandidates(item.candidates),
    };
  }

  const write = (name, data) => {
    writeFileSync(join(OUT_DIR, name), JSON.stringify(data, null, 2) + "\n");
  };

  write("KR.ko.global.json", globalOut);
  write("KR.ko.match.json", matchOut);
  write("KR.ko.base.json", baseOut);
  write("KR.ko.extra.json", extraOut);
  write("KR.ko.review.json", reviewOut);

  const counts = {
    globalCount: Object.keys(globalOut).length,
    matchCount: Object.keys(matchOut).length,
    baseCount: Object.keys(baseOut).length,
    extraCount: Object.keys(extraOut).length,
    reviewCount: Object.keys(reviewOut).length,
  };

  // ── SPEC.md ──────────────────────────────────────────────────────
  const generatedDate = new Date().toISOString().split("T")[0];
  const specMd = `# eshopkr/titledb — Output Specification

Generated: ${generatedDate}

## Identifiers

| Field | Common Name | Format | Example | Description |
|-------|------------|--------|---------|-------------|
| \`id\` | Title ID | 16-char hex | \`01004AB00A260000\` | Software title identifier, shared across regions |
| \`nsuId\` | eShop ID | Integer | \`70010000008802\` | eShop listing identifier, region-specific |

## Content Type (Title ID suffix)

| Suffix | Type | Description |
|--------|------|-------------|
| \`0x000\` | Base application | The main game |
| \`0x800\` | Patch/Update | Game updates |
| \`0x001\`–\`0x7FF\` | Add-on content | DLC |

## Output Files

### KR.ko.global.json

Full enriched KR eShop dataset. Object keyed by KR eShop ID (string).

Each entry contains all original fields from \`KR.ko.json\` plus:
- \`region\`: Corrected to \`"KR"\` (source data has \`null\`)
- \`titleIds\`: (only if matched) Region mappings grouped by Title ID

\`\`\`json
{
  "<krEshopId>": {
    "id": "string|null — Title ID (16-char hex)",
    "nsuId": "number — eShop ID",
    "name": "string — Title name",
    "region": "string — Always 'KR'",
    "publisher": "string|null",
    "releaseDate": "number|string|null — YYYYMMDD or YYYY-MM-DD",
    "size": "number|null — File size in bytes",
    "bannerUrl": "string|null — Banner image URL",
    "iconUrl": "string|null — Icon image URL",
    "category": "string[] — Game categories",
    "languages": "string[] — Supported languages",
    "titleIds": {
      "<titleId>": {
        "<foreignEshopId>": ["regionCode", "..."]
      }
    }
  }
}
\`\`\`

### KR.ko.match.json

Lightweight mapping — only the \`titleIds\` structure keyed by KR eShop ID.

\`\`\`json
{
  "<krEshopId>": {
    "<titleId>": {
      "<foreignEshopId>": ["regionCode", "..."]
    }
  }
}
\`\`\`

### KR.ko.base.json

Same structure as \`KR.ko.global.json\`, filtered to base games only (Title ID suffix \`000\` or entries without a Title ID).

### KR.ko.extra.json

Same structure as \`KR.ko.global.json\`, filtered to DLC (\`001\`–\`7FF\`) and updates (\`800\`) only.

### KR.ko.review.json

Low-confidence name matches pending human verification.

\`\`\`json
{
  "<krEshopId>": {
    "name": "string — KR title name",
    "id": "string|null — KR Title ID",
    "publisher": "string|null — KR publisher",
    "releaseDate": "number|string|null",
    "size": "number|null — bytes",
    "candidates": {
      "<candidateTitleId>": {
        "<candidateEshopId>": {
          "regions": ["string — region codes"],
          "name": "string — Candidate title name",
          "publisher": "string|null",
          "releaseDate": "number|string|null",
          "size": "number|null",
          "bannerUrl": "string|null",
          "iconUrl": "string|null",
          "reason": "string — Why auto-match failed (e.g. publisher_mismatch+date_too_far+size_diff_35pct)"
        }
      }
    }
  }
}
\`\`\`

#### Reason Codes

| Code | Meaning |
|------|---------|
| \`publisher_mismatch\` | Both publishers exist but don't match |
| \`publisher_not_comparable\` | One/both publisher names normalize to empty |
| \`date_too_far\` | Both dates exist but differ by >730 days |
| \`date_unavailable\` | One/both dates missing |
| \`size_diff_NNpct\` | Sizes differ by NN% (20–50%) |
| \`size_not_comparable\` | One/both sizes missing or below 10MB |

### spec.json

Machine-readable schema metadata for all output files.

### review.html

Visual review page with thumbnail images for human review of low-confidence matches.

### index.html

Dashboard with matching statistics, file descriptions, and navigation links.

## Matching Strategy

See [MATCHING_STRATEGY.md](../MATCHING_STRATEGY.md) for full details.

1. **Title ID exact match** — highest confidence
2. **Normalized name match + confirmation** — publisher/date/size signals required; cross-type matches (base↔DLC) rejected
3. **Single-candidate size promotion** — 1 candidate Title ID + size <20% + both >10MB
4. **Single-candidate fallback promotion** — 1 candidate Title ID + non-generic name (8+ chars) + size <50%
5. **pHash icon match** — perceptual hash comparison of icon images (US only, hamming distance <5%)
6. **Review queue** — remaining unconfirmed candidates
`;
  writeFileSync(join(OUT_DIR, "SPEC.md"), specMd);

  // ── spec.json ────────────────────────────────────────────────────
  const specJson = {
    name: "eshopkr/titledb",
    version: "1.0.0",
    generated: new Date().toISOString(),
    description: "Nintendo Switch KR eShop title matching across regions",
    source: "https://github.com/blawar/titledb",
    files: {
      "KR.ko.global.json": {
        description: "Full enriched KR eShop dataset with titleIds mappings",
        keyedBy: "nsuId (eShop ID, string)",
        entries: counts.globalCount,
      },
      "KR.ko.match.json": {
        description: "Lightweight titleIds mapping only",
        keyedBy: "nsuId (eShop ID, string)",
        entries: counts.matchCount,
      },
      "KR.ko.base.json": {
        description: "Base games only (Title ID suffix 000 or no ID)",
        keyedBy: "nsuId (eShop ID, string)",
        entries: counts.baseCount,
      },
      "KR.ko.extra.json": {
        description: "DLC and updates only (Title ID suffix 001-7FF, 800)",
        keyedBy: "nsuId (eShop ID, string)",
        entries: counts.extraCount,
      },
      "KR.ko.review.json": {
        description: "Low-confidence name matches for human review",
        keyedBy: "nsuId (eShop ID, string)",
        entries: counts.reviewCount,
      },
    },
    identifiers: {
      titleId: { field: "id", format: "16-char hex string", description: "Software title identifier, shared across regions" },
      eshopId: { field: "nsuId", format: "integer", description: "eShop listing identifier, region-specific" },
    },
    contentTypes: {
      base: { suffix: "0x000", description: "Base application" },
      dlc: { suffix: "0x001-0x7FF", description: "Add-on content" },
      update: { suffix: "0x800", description: "Patch/Update" },
    },
    matchingStrategies: [
      "Title ID exact match",
      "Normalized name match + confirmation (publisher/date/size)",
      "Single-candidate size promotion (<20%, >10MB)",
      "Single-candidate fallback promotion (non-generic name, <50%)",
      "pHash icon match (US only, hamming distance <5%)",
      "Review queue (unconfirmed)",
    ],
    stats: {
      krTotal: stats.krTotal,
      krWithId: stats.krWithId,
      regions: stats.regionCount,
      totalRegionEntries: stats.totalEntries,
      matched: counts.matchCount,
      idMatches: stats.idMatchCount,
      nameMatches: stats.nameMatchCount,
      sizeOnlyConfirm: stats.sizeMatchCount,
      aliasMatches: stats.aliasMatchCount,
      fallbackPromotions: stats.fallbackCount,
      phashMatches: stats.phashMatchCount || 0,
      reviewQueue: counts.reviewCount,
    },
  };
  write("spec.json", specJson);

  // ── review.html ──────────────────────────────────────────────────
  let reviewHtml = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>eshopkr/titledb — Review Queue</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;max-width:1200px;margin:0 auto;padding:20px;background:#f5f5f5;color:#1a1a1a}
h1{margin:0 0 4px}
.subtitle{color:#666;margin:0 0 20px}
.entry{background:#fff;border-radius:8px;padding:16px;margin:16px 0;box-shadow:0 1px 3px rgba(0,0,0,.1)}
.kr-info{display:flex;gap:16px;align-items:flex-start;border-bottom:1px solid #eee;padding-bottom:12px;margin-bottom:12px}
.thumbnail{width:160px;height:90px;object-fit:cover;border-radius:4px;background:#eee;flex-shrink:0}
.kr-meta h3{margin:0 0 6px;font-size:1.1em}
.meta{font-size:.85em;color:#666;line-height:1.6}
.candidates{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.candidate{background:#f9f9f9;padding:12px;border-radius:6px;border:1px solid #e0e0e0}
.candidate h4{margin:0 0 4px;font-size:.95em}
.cand-img{width:120px;height:68px;object-fit:cover;border-radius:3px;margin-bottom:6px;background:#eee}
.reason{display:inline-block;background:#fff3cd;color:#856404;padding:2px 8px;border-radius:3px;font-size:.8em;margin-top:4px}
.tag{display:inline-block;background:#e0e7ff;color:#3730a3;padding:1px 6px;border-radius:3px;font-size:.8em;margin-right:4px}
a{color:#2563eb}
.back-link{margin-bottom:16px;display:inline-block}
</style>
</head><body>
<a class="back-link" href="index.html">&larr; Back to dashboard</a>
<h1>eshopkr/titledb</h1>
<p class="subtitle">Review Queue &mdash; ${counts.reviewCount} entries pending human verification</p>
`;

  for (const [nsuId, item] of Object.entries(reviewOut)) {
    const krFull = krData[nsuId];
    const krImg = krFull?.bannerUrl || krFull?.iconUrl || "";
    reviewHtml += `<div class="entry" id="kr-${nsuId}">
  <div class="kr-info">
    ${krImg ? `<img class="thumbnail" src="${escapeHtml(krImg)}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<div class="thumbnail" style="display:flex;align-items:center;justify-content:center;color:#999;font-size:.8em">No image</div>`}
    <div class="kr-meta">
      <h3>${escapeHtml(item.name)}</h3>
      <div class="meta">
        <span class="tag">KR</span> eShop ID: ${escapeHtml(nsuId)} &bull; Title ID: <code>${escapeHtml(item.id || "none")}</code><br>
        Publisher: ${escapeHtml(item.publisher || "N/A")} &bull; Released: ${item.releaseDate || "N/A"} &bull; Size: ${formatSize(item.size)}
      </div>
    </div>
  </div>
  <div class="candidates">`;

    for (const [tid, eshops] of Object.entries(item.candidates)) {
      for (const [eid, info] of Object.entries(eshops)) {
        const candImg = info.bannerUrl || info.iconUrl || "";
        reviewHtml += `
    <div class="candidate">
      ${candImg ? `<img class="cand-img" src="${escapeHtml(candImg)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ""}
      <h4>${escapeHtml(info.name)}</h4>
      <div class="meta">
        Title ID: <code>${escapeHtml(tid)}</code> &bull; eShop ID: ${escapeHtml(eid)}<br>
        Regions: ${info.regions.map((r) => `<span class="tag">${escapeHtml(r)}</span>`).join("")}<br>
        Publisher: ${escapeHtml(info.publisher || "N/A")} &bull; Released: ${info.releaseDate || "N/A"} &bull; Size: ${formatSize(info.size)}
      </div>
      ${info.reason ? `<span class="reason">${escapeHtml(info.reason)}</span>` : ""}
    </div>`;
      }
    }
    reviewHtml += `
  </div>
</div>`;
  }

  reviewHtml += `
<p style="text-align:center;color:#999;margin-top:32px">Generated: ${new Date().toISOString()}</p>
</body></html>`;
  writeFileSync(join(OUT_DIR, "review.html"), reviewHtml);

  // ── index.html ───────────────────────────────────────────────────
  const matchedTypes = stats.matchedTypes;
  const indexHtml = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>eshopkr/titledb</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;max-width:960px;margin:0 auto;padding:20px;color:#1a1a1a}
h1{margin:0 0 4px}
.subtitle{color:#666;margin:0 0 24px}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:20px 0}
.stat-card{background:#f8f8f8;padding:16px;border-radius:8px;text-align:center;border:1px solid #e5e7eb}
.stat-card .value{font-size:1.8em;font-weight:bold;color:#2563eb}
.stat-card .label{color:#666;font-size:.85em;margin-top:2px}
table{border-collapse:collapse;width:100%;margin:16px 0}
th,td{border:1px solid #ddd;padding:8px 12px;text-align:left}
th{background:#f0f0f0;font-weight:600}
tr:hover{background:#fafafa}
a{color:#2563eb}
code{background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:.9em}
.section{margin:32px 0}
</style>
</head><body>
<h1>eshopkr/titledb</h1>
<p class="subtitle">Nintendo Switch KR eShop title matching across ${stats.regionCount} regions &bull; ${stats.totalEntries.toLocaleString()} total region entries</p>

<div class="stat-grid">
  <div class="stat-card"><div class="value">${stats.krTotal.toLocaleString()}</div><div class="label">KR Titles</div></div>
  <div class="stat-card"><div class="value">${stats.krWithId.toLocaleString()}</div><div class="label">With Title ID</div></div>
  <div class="stat-card"><div class="value">${counts.matchCount.toLocaleString()}</div><div class="label">Matched</div></div>
  <div class="stat-card"><div class="value">${stats.idMatchCount.toLocaleString()}</div><div class="label">via Title ID</div></div>
  <div class="stat-card"><div class="value">${stats.nameMatchCount.toLocaleString()}</div><div class="label">via Name</div></div>
  <div class="stat-card"><div class="value">${counts.reviewCount.toLocaleString()}</div><div class="label"><a href="review.html">In Review</a></div></div>
</div>

<div class="section">
<h2>Matching Breakdown</h2>
<table>
  <tr><th>Strategy</th><th>Count</th></tr>
  <tr><td>Title ID exact match</td><td>${stats.idMatchCount.toLocaleString()}</td></tr>
  <tr><td>Name match + confirmation</td><td>${(stats.nameMatchCount - stats.sizeMatchCount - stats.fallbackCount).toLocaleString()}</td></tr>
  <tr><td>&nbsp;&nbsp;Size-only confirmation</td><td>${stats.sizeMatchCount.toLocaleString()}</td></tr>
  <tr><td>&nbsp;&nbsp;Publisher alias match</td><td>${stats.aliasMatchCount.toLocaleString()}</td></tr>
  <tr><td>Fallback size promotion</td><td>${stats.fallbackCount.toLocaleString()}</td></tr>
  <tr><td>pHash icon match (US)</td><td>${(stats.phashMatchCount || 0).toLocaleString()}</td></tr>
  <tr><td>Review queue</td><td>${counts.reviewCount.toLocaleString()}</td></tr>
</table>
</div>

<div class="section">
<h2>Content Type Breakdown</h2>
<table>
  <tr><th>Type</th><th>KR Total</th><th>Matched</th></tr>
  <tr><td>Base Games</td><td>${stats.typeCounts.base.toLocaleString()}</td><td>${matchedTypes.base.toLocaleString()}</td></tr>
  <tr><td>DLC</td><td>${stats.typeCounts.dlc.toLocaleString()}</td><td>${matchedTypes.dlc.toLocaleString()}</td></tr>
  <tr><td>Updates</td><td>${stats.typeCounts.update.toLocaleString()}</td><td>${matchedTypes.update.toLocaleString()}</td></tr>
  <tr><td>No ID</td><td>${stats.typeCounts["no-id"].toLocaleString()}</td><td>${matchedTypes["no-id"].toLocaleString()}</td></tr>
</table>
</div>

<div class="section">
<h2>Output Files</h2>
<table>
  <tr><th>File</th><th>Description</th><th>Entries</th></tr>
  <tr><td><a href="KR.ko.global.json"><code>KR.ko.global.json</code></a></td><td>Full enriched KR dataset with region mappings</td><td>${counts.globalCount.toLocaleString()}</td></tr>
  <tr><td><a href="KR.ko.match.json"><code>KR.ko.match.json</code></a></td><td>Lightweight titleIds mapping only</td><td>${counts.matchCount.toLocaleString()}</td></tr>
  <tr><td><a href="KR.ko.base.json"><code>KR.ko.base.json</code></a></td><td>Base games only</td><td>${counts.baseCount.toLocaleString()}</td></tr>
  <tr><td><a href="KR.ko.extra.json"><code>KR.ko.extra.json</code></a></td><td>DLC and updates only</td><td>${counts.extraCount.toLocaleString()}</td></tr>
  <tr><td><a href="KR.ko.review.json"><code>KR.ko.review.json</code></a></td><td>Low-confidence matches for human review</td><td>${counts.reviewCount.toLocaleString()}</td></tr>
  <tr><td><a href="review.html"><code>review.html</code></a></td><td>Visual review page with thumbnails</td><td>${counts.reviewCount.toLocaleString()}</td></tr>
  <tr><td><a href="SPEC.md"><code>SPEC.md</code></a></td><td>Output format specification</td><td>&mdash;</td></tr>
  <tr><td><a href="spec.json"><code>spec.json</code></a></td><td>Machine-readable schema</td><td>&mdash;</td></tr>
</table>
</div>

<p style="color:#999;margin-top:32px">Generated: ${new Date().toISOString()} &bull; <a href="SPEC.md">Format Specification</a></p>
</body></html>`;
  writeFileSync(join(OUT_DIR, "index.html"), indexHtml);

  return counts;
}

// ─── Main ────────────────────────────────────────────────────────────

console.time("Total");

console.log("Loading KR.ko.json...");
const krData = JSON.parse(readFileSync(join(DATA_DIR, "KR.ko.json"), "utf8"));
const krTotal = Object.keys(krData).length;
const krWithId = Object.values(krData).filter((e) => e.id).length;
console.log(`  KR entries: ${krTotal} (with ID: ${krWithId})`);

// Content type breakdown
const typeCounts = { base: 0, dlc: 0, update: 0, "no-id": 0 };
for (const e of Object.values(krData)) typeCounts[classifyTitleId(e.id)]++;
console.log(`  Base: ${typeCounts.base}, DLC: ${typeCounts.dlc}, Update: ${typeCounts.update}, No ID: ${typeCounts["no-id"]}`);

console.log("Loading region files...");
const regionData = loadRegionFiles();
const regionCount = Object.keys(regionData).length;
let totalEntries = 0;
for (const r of Object.values(regionData)) totalEntries += Object.keys(r).length;
console.log(`  Regions: ${regionCount}, Total entries: ${totalEntries}`);

console.log("Matching...");
const { matched, review, idMatchCount, nameMatchCount, sizeMatchCount, aliasMatchCount, fallbackCount, phashMatchCount } = matchAll(krData, regionData);

console.log("\n═══ Results ═══");
console.log(`KR titles total:        ${krTotal}`);
console.log(`KR titles with ID:      ${krWithId}`);
console.log(`Matched (any region):   ${Object.keys(matched).length}`);
console.log(`  via Title ID:         ${idMatchCount}`);
console.log(`  via Name similarity:  ${nameMatchCount}`);
console.log(`    (size-only confirm: ${sizeMatchCount})`);
console.log(`    (alias pub match:   ${aliasMatchCount})`);
console.log(`    (fallback promote:  ${fallbackCount})`);
console.log(`  via pHash icon:       ${phashMatchCount}`);
console.log(`Review queue:           ${Object.keys(review).length}`);

// Matched breakdown by content type
const matchedTypes = { base: 0, dlc: 0, update: 0, "no-id": 0 };
for (const nsuId of Object.keys(matched)) {
  matchedTypes[classifyTitleId(krData[nsuId]?.id)]++;
}
console.log(`\nMatched by content type:`);
console.log(`  Base games:  ${matchedTypes.base}`);
console.log(`  DLC:         ${matchedTypes.dlc}`);
console.log(`  No ID:       ${matchedTypes["no-id"]}`);

// Region breakdown
const regionStats = {};
for (const regionMatches of Object.values(matched)) {
  for (const region of Object.keys(regionMatches)) {
    regionStats[region] = (regionStats[region] || 0) + 1;
  }
}
console.log("\nTop regions by match count:");
const sorted = Object.entries(regionStats)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15);
for (const [region, count] of sorted) {
  console.log(`  ${region}: ${count}`);
}

console.log("\nWriting output files...");
const counts = writeOutputs(krData, matched, review, {
  krTotal, krWithId, typeCounts, regionCount, totalEntries,
  idMatchCount, nameMatchCount, sizeMatchCount, aliasMatchCount, fallbackCount, phashMatchCount,
  matchedTypes,
});
console.log(`  KR.ko.global.json  (${counts.globalCount} entries)`);
console.log(`  KR.ko.match.json   (${counts.matchCount} matched)`);
console.log(`  KR.ko.base.json    (${counts.baseCount} base games)`);
console.log(`  KR.ko.extra.json   (${counts.extraCount} DLC/updates)`);
console.log(`  KR.ko.review.json  (${counts.reviewCount} for review)`);
console.log(`  SPEC.md, spec.json, review.html, index.html`);

console.timeEnd("Total");
