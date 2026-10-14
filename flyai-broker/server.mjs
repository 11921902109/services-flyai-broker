import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const cliPackagePath = require.resolve("@fly-ai/flyai-cli/package.json");
const cliPath = join(dirname(cliPackagePath), "dist", "flyai-bundle.cjs");

const host = process.env.HOST?.trim() || "0.0.0.0";
const port = readPort(process.env.PORT);
const brokerToken = requiredSecret("BROKER_SHARED_TOKEN", process.env.BROKER_SHARED_TOKEN);
const flyAiApiKey = requiredSecret("FLYAI_API_KEY", process.env.FLYAI_API_KEY);

// The upstream credential should exist only in this broker's memory and in the
// short-lived official CLI child process, never in its command line or response.
delete process.env.FLYAI_API_KEY;

const BODY_LIMIT_BYTES = 32 * 1024;
const STDOUT_LIMIT_BYTES = 2 * 1024 * 1024;
const STDERR_LIMIT_BYTES = 64 * 1024;
const CHILD_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_SEARCHES = readBoundedInteger(
  process.env.MAX_CONCURRENT_SEARCHES,
  4,
  1,
  16,
);

const HOTEL_SORTS = new Set([
  "distance_asc",
  "rate_desc",
  "price_asc",
  "price_desc",
  "no_rank",
]);
const HOTEL_TYPES = new Set(["hotel", "homestay", "inn"]);
const HOTEL_BED_TYPES = new Set(["king", "twin", "multi"]);
const POI_CATEGORIES = new Set([
  "自然风光",
  "山湖田园",
  "森林丛林",
  "峡谷瀑布",
  "沙滩海岛",
  "沙漠草原",
  "人文古迹",
  "古镇古村",
  "历史古迹",
  "园林花园",
  "宗教场所",
  "公园乐园",
  "主题乐园",
  "水上乐园",
  "影视基地",
  "动物园",
  "植物园",
  "海洋馆",
  "体育场馆",
  "演出赛事",
  "剧院剧场",
  "博物馆",
  "纪念馆",
  "展览馆",
  "地标建筑",
  "市集",
  "文创街区",
  "城市观光",
  "户外活动",
  "滑雪",
  "漂流",
  "冲浪",
  "潜水",
  "露营",
  "温泉",
]);

let activeSearches = 0;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const server = createServer(async (request, response) => {
  setSecurityHeaders(response);

  try {
    const url = new URL(request.url || "/", "http://broker.internal");

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "flyai-broker" });
      return;
    }

    if (url.pathname !== "/v1/search") {
      throw new ApiError(404, "NOT_FOUND", "Route not found.");
    }

    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
    }

    authenticate(request.headers.authorization);

    const contentType = request.headers["content-type"] || "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
    }

    if (activeSearches >= MAX_CONCURRENT_SEARCHES) {
      throw new ApiError(429, "BROKER_BUSY", "Too many searches are running. Try again shortly.");
    }

    const body = await readJsonBody(request);
    const command = buildCommand(body);

    activeSearches += 1;
    try {
      const result = await runOfficialCli(command);
      sendJson(response, 200, { ok: true, action: body.action, result });
    } finally {
      activeSearches -= 1;
    }
  } catch (error) {
    const apiError = normalizeError(error);
    sendJson(response, apiError.status, {
      ok: false,
      error: { code: apiError.code, message: apiError.message },
    });
  }
});

server.requestTimeout = 35_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 64;

server.listen(port, host, () => {
  console.info(`flyai-broker listening on ${host}:${port}`);
});

function buildCommand(body) {
  assertObject(body, "body");
  assertOnlyKeys(body, ["action", "params"], "body");

  const action = readEnum(body.action, "action", new Set(["hotel", "poi", "keyword"]));
  const params = body.params;
  assertObject(params, "params");

  if (action === "hotel") return buildHotelCommand(params);
  if (action === "poi") return buildPoiCommand(params);
  return buildKeywordCommand(params);
}

function buildHotelCommand(params) {
  const allowed = [
    "destName",
    "keyWords",
    "poiName",
    "hotelTypes",
    "sort",
    "checkInDate",
    "checkOutDate",
    "hotelStars",
    "hotelBedTypes",
    "maxPrice",
  ];
  assertOnlyKeys(params, allowed, "params");

  const destName = readString(params.destName, "params.destName", { min: 1, max: 100 });
  const args = ["search-hotel", "--dest-name", destName];

  addOptionalString(args, "--key-words", params.keyWords, "params.keyWords", 200);
  addOptionalString(args, "--poi-name", params.poiName, "params.poiName", 200);

  if (params.hotelTypes !== undefined) {
    args.push(
      "--hotel-types",
      readCommaSeparatedEnum(params.hotelTypes, "params.hotelTypes", HOTEL_TYPES),
    );
  }

  if (params.sort !== undefined) {
    args.push("--sort", readEnum(params.sort, "params.sort", HOTEL_SORTS));
  }

  const checkInDate = readOptionalDate(params.checkInDate, "params.checkInDate");
  const checkOutDate = readOptionalDate(params.checkOutDate, "params.checkOutDate");
  if ((checkInDate && !checkOutDate) || (!checkInDate && checkOutDate)) {
    throw new ApiError(
      400,
      "INVALID_PARAMS",
      "params.checkInDate and params.checkOutDate must be supplied together.",
    );
  }
  if (checkInDate && checkOutDate) {
    if (checkOutDate <= checkInDate) {
      throw new ApiError(400, "INVALID_PARAMS", "params.checkOutDate must be after check-in.");
    }
    args.push("--check-in-date", checkInDate, "--check-out-date", checkOutDate);
  }

  if (params.hotelStars !== undefined) {
    const stars = readString(params.hotelStars, "params.hotelStars", { min: 1, max: 9 });
    if (!/^[1-5](?:,[1-5])*$/.test(stars) || hasDuplicates(stars.split(","))) {
      throw new ApiError(400, "INVALID_PARAMS", "params.hotelStars must be unique values from 1 to 5.");
    }
    args.push("--hotel-stars", stars);
  }

  if (params.hotelBedTypes !== undefined) {
    args.push(
      "--hotel-bed-types",
      readCommaSeparatedEnum(params.hotelBedTypes, "params.hotelBedTypes", HOTEL_BED_TYPES),
    );
  }

  if (params.maxPrice !== undefined) {
    args.push("--max-price", String(readInteger(params.maxPrice, "params.maxPrice", 1, 1_000_000)));
  }

  return args;
}

function buildPoiCommand(params) {
  assertOnlyKeys(params, ["cityName", "poiLevel", "keyword", "category"], "params");

  const cityName = readString(params.cityName, "params.cityName", { min: 1, max: 100 });
  const args = ["search-poi", "--city-name", cityName];

  if (params.poiLevel !== undefined) {
    args.push("--poi-level", String(readInteger(params.poiLevel, "params.poiLevel", 1, 5)));
  }
  addOptionalString(args, "--keyword", params.keyword, "params.keyword", 200);
  if (params.category !== undefined) {
    args.push("--category", readEnum(params.category, "params.category", POI_CATEGORIES));
  }

  return args;
}

function buildKeywordCommand(params) {
  assertOnlyKeys(params, ["query"], "params");
  return [
    "keyword-search",
    "--query",
    readString(params.query, "params.query", { min: 2, max: 500 }),
  ];
}

function runOfficialCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildChildEnvironment(),
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const failAndKill = (error) => {
      child.kill("SIGKILL");
      finish(() => reject(error));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      failAndKill(new ApiError(504, "FLYAI_TIMEOUT", "FlyAI did not respond within 30 seconds."));
    }, CHILD_TIMEOUT_MS);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > STDOUT_LIMIT_BYTES) {
        failAndKill(new ApiError(502, "FLYAI_OUTPUT_TOO_LARGE", "FlyAI returned too much data."));
        return;
      }
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= STDERR_LIMIT_BYTES) stderr += chunk.toString("utf8");
    });

    child.on("error", () => {
      finish(() => reject(new ApiError(502, "FLYAI_START_FAILED", "FlyAI could not be started.")));
    });

    child.on("close", (code) => {
      if (settled || timedOut) return;
      finish(() => {
        if (code !== 0) {
          reject(new ApiError(502, "FLYAI_UPSTREAM_ERROR", summarizeCliError(stderr)));
          return;
        }

        const output = stdout.trim();
        if (!output) {
          reject(new ApiError(502, "FLYAI_EMPTY_RESPONSE", "FlyAI returned an empty response."));
          return;
        }

        try {
          resolve(JSON.parse(output));
        } catch {
          reject(new ApiError(502, "FLYAI_INVALID_RESPONSE", "FlyAI returned invalid JSON."));
        }
      });
    });
  });
}

function buildChildEnvironment() {
  const allowedNames = [
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "WINDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TZ",
    "NODE_EXTRA_CA_CERTS",
  ];
  const env = {};
  for (const name of allowedNames) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.FLYAI_API_KEY = flyAiApiKey;
  env.NO_COLOR = "1";
  return env;
}

function authenticate(authorization) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new ApiError(401, "UNAUTHORIZED", "A bearer token is required.");
  }
  const supplied = authorization.slice(7);
  if (!supplied || !safeEqual(supplied, brokerToken)) {
    throw new ApiError(401, "UNAUTHORIZED", "The bearer token is invalid.");
  }
}

function safeEqual(left, right) {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let body = "";
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > BODY_LIMIT_BYTES) {
        fail(new ApiError(413, "BODY_TOO_LARGE", "Request body exceeds 32 KiB."));
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new ApiError(400, "INVALID_JSON", "Request body must be valid JSON."));
      }
    });
    request.on("error", () => fail(new ApiError(400, "REQUEST_ERROR", "Request body could not be read.")));
  });
}

function readString(value, name, { min, max }) {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_PARAMS", `${name} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new ApiError(400, "INVALID_PARAMS", `${name} must contain ${min}-${max} characters.`);
  }
  if (/^[\-]/.test(normalized) || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ApiError(400, "INVALID_PARAMS", `${name} contains unsupported characters.`);
  }
  return normalized;
}

function readEnum(value, name, allowed) {
  const normalized = readString(value, name, { min: 1, max: 100 });
  if (!allowed.has(normalized)) {
    throw new ApiError(400, "INVALID_PARAMS", `${name} is not an allowed value.`);
  }
  return normalized;
}

function readCommaSeparatedEnum(value, name, allowed) {
  const normalized = readString(value, name, { min: 1, max: 100 });
  const values = normalized.split(",");
  if (values.some((item) => !allowed.has(item)) || hasDuplicates(values)) {
    throw new ApiError(400, "INVALID_PARAMS", `${name} contains an unsupported or duplicate value.`);
  }
  return normalized;
}

function readInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(400, "INVALID_PARAMS", `${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function readOptionalDate(value, name) {
  if (value === undefined) return undefined;
  const normalized = readString(value, name, { min: 10, max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new ApiError(400, "INVALID_PARAMS", `${name} must use YYYY-MM-DD.`);
  }
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw new ApiError(400, "INVALID_PARAMS", `${name} is not a valid calendar date.`);
  }
  return normalized;
}

function addOptionalString(args, flag, value, name, max) {
  if (value === undefined) return;
  args.push(flag, readString(value, name, { min: 1, max }));
}

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_PARAMS", `${name} must be an object.`);
  }
}

function assertOnlyKeys(value, allowed, name) {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) {
    throw new ApiError(400, "INVALID_PARAMS", `${name}.${unexpected} is not supported.`);
  }
}

function hasDuplicates(values) {
  return new Set(values).size !== values.length;
}

function requiredSecret(name, value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < 24) {
    throw new Error(`${name} is required and must contain at least 24 characters.`);
  }
  return normalized;
}

function readPort(value) {
  if (value === undefined || value === "") return 8788;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535.");
  }
  return number;
}

function readBoundedInteger(value, fallback, min, max) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`Value must be an integer from ${min} to ${max}.`);
  }
  return number;
}

function summarizeCliError(stderr) {
  const normalized = stderr.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (/401|unauthorized|api.?key/i.test(normalized)) {
    return "FlyAI rejected the server credential.";
  }
  if (/timeout|timed out/i.test(normalized)) {
    return "FlyAI timed out upstream.";
  }
  return "FlyAI could not complete the search.";
}

function normalizeError(error) {
  if (error instanceof ApiError) return error;
  return new ApiError(500, "INTERNAL_ERROR", "The broker could not complete the request.");
}

function setSecurityHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(response, status, payload) {
  if (response.headersSent || response.destroyed) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}
