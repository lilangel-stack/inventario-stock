const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");

const root = __dirname;
let port = Number(process.env.PORT) || 3000;
const databasePath = process.env.DATABASE_PATH || path.join(root, "data", "mi-negocio.sqlite");
const sessionDuration = 30 * 24 * 60 * 60 * 1000;
const passwordLength = 64;
const recordStores = ["products", "purchases", "sales", "expenses"];
const scrypt = promisify(crypto.scrypt);
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiration ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS app_data (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    store_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (user_id, store_name, record_id)
  );
  CREATE TABLE IF NOT EXISTS workspace (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
  );
`);

const existingUserColumns = new Set(
  database.prepare("PRAGMA table_info(users)").all().map((column) => column.name),
);
for (const [column, definition] of [
  ["first_name", "TEXT NOT NULL DEFAULT ''"],
  ["last_name", "TEXT NOT NULL DEFAULT ''"],
  ["store_name", "TEXT NOT NULL DEFAULT 'Mi negocio'"],
  ["access_key_hash", "TEXT"],
]) {
  if (!existingUserColumns.has(column)) {
    database.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
  }
}

database.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_access_key_hash ON users(access_key_hash) WHERE access_key_hash IS NOT NULL");

const findWorkspaceId = database.prepare("SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1");
if (!database.prepare("SELECT user_id FROM workspace WHERE singleton = 1").get()) {
  const existingWorkspace = findWorkspaceId.get();
  if (existingWorkspace) {
    database.prepare("INSERT INTO workspace (singleton, user_id) VALUES (1, ?)").run(existingWorkspace.id);
  }
}

const findUserById = database.prepare(
  "SELECT id, first_name, last_name, store_name FROM users WHERE id = ?",
);
const findUserByAccessKeyHash = database.prepare(
  "SELECT id, first_name, last_name, store_name, password_salt, password_hash FROM users WHERE access_key_hash = ?",
);
const findLegacyUsers = database.prepare(
  "SELECT id, first_name, last_name, store_name, password_salt, password_hash FROM users WHERE access_key_hash IS NULL",
);
const updateAccessKeyHash = database.prepare(
  "UPDATE users SET access_key_hash = ? WHERE id = ? AND access_key_hash IS NULL",
);
const insertUser = database.prepare(
  "INSERT INTO users (id, email, first_name, last_name, store_name, password_salt, password_hash, access_key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
const insertSession = database.prepare(
  "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
);
const findSession = database.prepare(
  "SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?",
);
const deleteSession = database.prepare("DELETE FROM sessions WHERE token_hash = ?");
const deleteExpiredSessions = database.prepare("DELETE FROM sessions WHERE expires_at <= ?");
const getUserData = database.prepare(
  "SELECT store_name, record_json FROM app_data WHERE user_id = ?",
);
const saveUserData = database.prepare(
  `INSERT INTO app_data (user_id, store_name, record_id, record_json)
   VALUES (?, ?, ?, ?)
   ON CONFLICT (user_id, store_name, record_id)
   DO UPDATE SET record_json = excluded.record_json`,
);
const rateLimits = new Map();

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function hashAccessKey(password) {
  const lookupHash = await scrypt(password, Buffer.from("mi-negocio-access-key-index-v1"), 32, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return lookupHash.toString("hex");
}

function requestCookies(request) {
  return Object.fromEntries(
    (request.headers.cookie || "").split(";").flatMap((cookie) => {
      const separator = cookie.indexOf("=");
      if (separator < 0) return [];
      return [[cookie.slice(0, separator).trim(), cookie.slice(separator + 1).trim()]];
    }),
  );
}

function sessionCookie(token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `mi_negocio_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionDuration / 1000}${secure}`;
}

function clearedSessionCookie() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `mi_negocio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
}

function requireSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) throw new HttpError(403, "Origen de solicitud no permitido.");
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new HttpError(403, "Origen de solicitud no permitido.");
  }
  if (
    parsedOrigin.host !== request.headers.host ||
    !["http:", "https:"].includes(parsedOrigin.protocol) ||
    (process.env.NODE_ENV === "production" && parsedOrigin.protocol !== "https:")
  ) {
    throw new HttpError(403, "Origen de solicitud no permitido.");
  }
}

async function readJson(request) {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "El tipo de contenido debe ser JSON.");
  }
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString("utf8");
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) {
      throw new HttpError(413, "La solicitud es demasiado grande.");
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError(400, "El contenido JSON no es válido.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "El contenido JSON debe ser un objeto.");
  }
  return parsed;
}

async function enforceRateLimit(request, route) {
  const now = Date.now();
  const key = `${route}:${request.socket.remoteAddress || "unknown"}`;
  const previous = rateLimits.get(key);
  if (!previous || now - previous.startedAt >= 15 * 60 * 1000) {
    rateLimits.set(key, { startedAt: now, count: 1 });
    return;
  }
  previous.count += 1;
  if (previous.count > 10) throw new HttpError(429, "Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.");
}

function getAuthenticatedUser(request) {
  const token = requestCookies(request).mi_negocio_session;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const session = findSession.get(hashToken(token), Date.now());
  if (!session) return null;
  return findUserById.get(session.user_id) || null;
}

function requireAuthenticatedUser(request) {
  const user = getAuthenticatedUser(request);
  if (!user) throw new HttpError(401, "Inicia sesión para continuar.");
  return user;
}

function createSession(user, response) {
  deleteExpiredSessions.run(Date.now());
  const token = crypto.randomBytes(32).toString("hex");
  insertSession.run(hashToken(token), user.id, Date.now() + sessionDuration);
  response.setHeader("Set-Cookie", sessionCookie(token));
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    throw new HttpError(400, "La clave debe tener entre 8 y 128 caracteres.");
  }
}

function validateNewAccessKey(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    throw new HttpError(400, "Crea una clave especial de entre 12 y 128 caracteres.");
  }
}

async function matchesAccessKey(password, user) {
  const salt = Buffer.from(user.password_salt, "hex");
  const expectedHash = Buffer.from(user.password_hash, "hex");
  const actualHash = await scrypt(password, salt, passwordLength, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(expectedHash, actualHash);
}

function normalizeProfileField(value, label) {
  if (typeof value !== "string") throw new HttpError(400, `Ingresa ${label}.`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 80) {
    throw new HttpError(400, `${label[0].toUpperCase()}${label.slice(1)} debe tener entre 1 y 80 caracteres.`);
  }
  return normalized;
}

function emptyData() {
  return Object.fromEntries(recordStores.map((store) => [store, []]));
}

function loadData(userId) {
  const result = emptyData();
  for (const row of getUserData.all(userId)) {
    result[row.store_name].push(JSON.parse(row.record_json));
  }
  return result;
}

function persistData(userId, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpError(400, "Los datos recibidos no tienen un formato válido.");
  }
  const records = [];
  for (const store of recordStores) {
    const items = data[store] ?? [];
    if (!Array.isArray(items)) throw new HttpError(400, "La lista de datos no tiene un formato válido.");
    for (const record of items) {
      if (
        !record ||
        typeof record !== "object" ||
        Array.isArray(record) ||
        typeof record.id !== "string" ||
        record.id.length < 1 ||
        record.id.length > 100
      ) {
        throw new HttpError(400, "Uno de los registros no tiene un identificador válido.");
      }
      records.push([store, record.id, JSON.stringify(record)]);
      if (records.length > 10000) throw new HttpError(413, "Hay demasiados registros en una sola solicitud.");
    }
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const [store, id, json] of records) {
      saveUserData.run(userId, store, id, json);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/session") {
    const user = getAuthenticatedUser(request);
    return sendJson(response, 200, { user: user ? {
      firstName: user.first_name,
      lastName: user.last_name,
      storeName: user.store_name,
    } : null, storesConfigured: Boolean(findWorkspaceId.get()) });
  }

  if (request.method === "POST" && (pathname === "/api/register" || pathname === "/api/login")) {
    requireSameOrigin(request);
    await enforceRateLimit(request, pathname);
    const body = await readJson(request);
    validatePassword(body.password);

    if (pathname === "/api/register") {
      validateNewAccessKey(body.password);
      const accessKeyHash = await hashAccessKey(body.password);
      if (findUserByAccessKeyHash.get(accessKeyHash)) {
        throw new HttpError(409, "Esa clave ya pertenece a otra tienda. Crea una clave diferente para esta tienda.");
      }
      for (const legacyUser of findLegacyUsers.all()) {
        if (await matchesAccessKey(body.password, legacyUser)) {
          throw new HttpError(409, "Esa clave ya pertenece a otra tienda. Crea una clave diferente para esta tienda.");
        }
      }
      const firstName = normalizeProfileField(body.firstName, "tu nombre");
      const lastName = normalizeProfileField(body.lastName, "tu apellido");
      const storeName = normalizeProfileField(body.storeName, "el nombre de tu tienda");
      const salt = crypto.randomBytes(16);
      const passwordHash = await scrypt(body.password, salt, passwordLength, {
        N: 16384,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
      });
      const id = crypto.randomUUID();
      const user = { id, firstName, lastName, storeName };
      let transactionStarted = false;
      try {
        database.exec("BEGIN IMMEDIATE");
        transactionStarted = true;
        if (findUserByAccessKeyHash.get(accessKeyHash)) {
          database.exec("ROLLBACK");
          transactionStarted = false;
          throw new HttpError(409, "Esa clave ya pertenece a otra tienda. Crea una clave diferente para esta tienda.");
        }
        insertUser.run(
          user.id,
          `workspace-${user.id}@mi-negocio.local`,
          user.firstName,
          user.lastName,
          user.storeName,
          salt.toString("hex"),
          passwordHash.toString("hex"),
          accessKeyHash,
          Date.now(),
        );
        database.exec("COMMIT");
        transactionStarted = false;
      } catch (error) {
        if (transactionStarted) database.exec("ROLLBACK");
        if (error instanceof HttpError) throw error;
        if (error.errcode === 2067 || error.code === "ERR_SQLITE_CONSTRAINT_UNIQUE") {
          throw new HttpError(409, "Esa clave ya pertenece a otra tienda. Crea una clave diferente para esta tienda.");
        }
        throw error;
      }
      createSession(user, response);
      return sendJson(response, 201, { user: {
        firstName,
        lastName,
        storeName,
      } });
    }

    const accessKeyHash = await hashAccessKey(body.password);
    let user = findUserByAccessKeyHash.get(accessKeyHash);
    let authenticated = false;
    if (!user) {
      for (const legacyUser of findLegacyUsers.all()) {
        if (await matchesAccessKey(body.password, legacyUser)) {
          user = legacyUser;
          authenticated = true;
          break;
        }
      }
    } else {
      authenticated = await matchesAccessKey(body.password, user);
    }
    if (!user || !authenticated) {
      throw new HttpError(401, "La clave especial no es correcta.");
    }
    if (!user.access_key_hash) {
      try {
        updateAccessKeyHash.run(accessKeyHash, user.id);
      } catch (error) {
        if (error.errcode === 2067 || error.code === "ERR_SQLITE_CONSTRAINT_UNIQUE") {
          throw new HttpError(401, "La clave especial no es correcta.");
        }
        throw error;
      }
    }
    createSession(user, response);
    return sendJson(response, 200, { user: {
      firstName: user.first_name,
      lastName: user.last_name,
      storeName: user.store_name,
    } });
  }

  if (request.method === "POST" && pathname === "/api/logout") {
    requireSameOrigin(request);
    const token = requestCookies(request).mi_negocio_session;
    if (token && /^[a-f0-9]{64}$/.test(token)) deleteSession.run(hashToken(token));
    return sendJson(response, 200, { ok: true }, { "Set-Cookie": clearedSessionCookie() });
  }

  if (request.method === "GET" && pathname === "/api/data") {
    const user = requireAuthenticatedUser(request);
    return sendJson(response, 200, { data: loadData(user.id) });
  }

  if (request.method === "PUT" && pathname === "/api/data") {
    requireSameOrigin(request);
    const user = requireAuthenticatedUser(request);
    const body = await readJson(request);
    persistData(user.id, body.data);
    return sendJson(response, 200, { ok: true });
  }

  throw new HttpError(404, "No se encontró este recurso.");
}

async function handleRequest(request, response) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    throw new HttpError(400, "La dirección solicitada no es válida.");
  }

  if (pathname.startsWith("/api/")) {
    return handleApi(request, response, pathname);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new HttpError(405, "Método no permitido.");
  }
  const file = staticFiles.get(pathname);
  if (!file) throw new HttpError(404, "No se encontró esta página.");

  const filePath = path.join(root, file[0]);
  const content = await fs.promises.readFile(filePath);
  response.writeHead(200, {
    "Content-Type": file[1],
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
  });
  response.end(request.method === "HEAD" ? undefined : content);
}

const server = http.createServer((request, response) => {
  Promise.resolve(handleRequest(request, response)).catch((error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    if (error instanceof HttpError) {
      sendJson(response, error.status, { error: error.message });
      return;
    }
    console.error("Error procesando una solicitud:", error);
    sendJson(response, 500, { error: "Ocurrió un error interno. Inténtalo de nuevo." });
  });
});

server.on("listening", () => {
  console.log(`Mi negocio disponible en http://localhost:${port}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && port < 65535) {
    const occupiedPort = port;
    port += 1;
    console.warn(`El puerto ${occupiedPort} ya está en uso. Probando el puerto ${port}...`);
    server.listen(port, "0.0.0.0");
    return;
  }

  console.error("No se pudo iniciar el servidor:", error);
  process.exitCode = 1;
});

server.listen(port, "0.0.0.0");
