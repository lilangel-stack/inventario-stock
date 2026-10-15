const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const { Pool } = require("pg");

const root = __dirname;
let port = Number(process.env.PORT) || 3000;
const databasePath = process.env.DATABASE_PATH || path.join(root, "data", "mi-negocio.sqlite");
const postgresUrl = process.env.DATABASE_URL;
const sessionDuration = 30 * 24 * 60 * 60 * 1000;
const passwordLength = 64;
const recordStores = ["products", "purchases", "sales", "expenses"];
const scrypt = promisify(crypto.scrypt);
const app = express();
app.disable("x-powered-by");
const database = postgresUrl ? new Pool({
  connectionString: postgresUrl,
  max: 5,
}) : process.env.NODE_ENV === "production" ? null : new DatabaseSync(databasePath);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function toPostgresSql(sql) {
  let parameter = 0;
  return sql.replace(/\?/g, () => `$${++parameter}`);
}

function get(sql, values = [], connection = database) {
  if (postgresUrl) return connection.query(toPostgresSql(sql), values).then(({ rows }) => rows[0]);
  return Promise.resolve(connection.prepare(sql).get(...values));
}

function all(sql, values = [], connection = database) {
  if (postgresUrl) return connection.query(toPostgresSql(sql), values).then(({ rows }) => rows);
  return Promise.resolve(connection.prepare(sql).all(...values));
}

function run(sql, values = [], connection = database) {
  if (postgresUrl) return connection.query(toPostgresSql(sql), values);
  return Promise.resolve(connection.prepare(sql).run(...values));
}

async function withTransaction(callback) {
  if (postgresUrl) {
    const connection = await database.connect();
    try {
      await connection.query("BEGIN");
      const result = await callback(connection);
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const result = await callback(database);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function initializeDatabase() {
  if (process.env.NODE_ENV === "production" && !postgresUrl) {
    throw new Error("Configura DATABASE_URL con una base PostgreSQL persistente antes de iniciar en producción.");
  }
  if (postgresUrl) {
    await database.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        first_name TEXT NOT NULL DEFAULT '',
        last_name TEXT NOT NULL DEFAULT '',
        store_name TEXT NOT NULL DEFAULT 'Mi negocio',
        access_key_hash TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at BIGINT NOT NULL
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
      CREATE UNIQUE INDEX IF NOT EXISTS users_access_key_hash
        ON users(access_key_hash) WHERE access_key_hash IS NOT NULL;
    `);
  } else {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
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
  }

  const workspace = await get("SELECT user_id FROM workspace WHERE singleton = 1");
  if (!workspace) {
    const user = await get("SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1");
    if (user) await run("INSERT INTO workspace (singleton, user_id) VALUES (1, ?)", [user.id]);
  }
}

const rateLimits = new Map();

function sendJson(response, status, body, headers = {}) {
  response.status(status).set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    ...headers,
  }).json(body);
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
  if (!request.is("application/json")) {
    throw new HttpError(415, "El tipo de contenido debe ser JSON.");
  }
  const parsed = request.body;
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

async function getAuthenticatedUser(request) {
  const token = requestCookies(request).mi_negocio_session;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const session = await get(
    "SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?",
    [hashToken(token), Date.now()],
  );
  if (!session) return null;
  return (await get(
    "SELECT id, first_name, last_name, store_name FROM users WHERE id = ?",
    [session.user_id],
  )) || null;
}

async function requireAuthenticatedUser(request) {
  const user = await getAuthenticatedUser(request);
  if (!user) throw new HttpError(401, "Inicia sesión para continuar.");
  return user;
}

async function createSession(user, response) {
  await run("DELETE FROM sessions WHERE expires_at <= ?", [Date.now()]);
  const token = crypto.randomBytes(32).toString("hex");
  await run(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    [hashToken(token), user.id, Date.now() + sessionDuration],
  );
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

async function loadData(userId) {
  const result = emptyData();
  for (const row of await all("SELECT store_name, record_json FROM app_data WHERE user_id = ?", [userId])) {
    result[row.store_name].push(JSON.parse(row.record_json));
  }
  return result;
}

async function persistData(userId, data) {
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
  await withTransaction(async (connection) => {
    for (const [store, id, json] of records) {
      await run(
        `INSERT INTO app_data (user_id, store_name, record_id, record_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, store_name, record_id)
         DO UPDATE SET record_json = excluded.record_json`,
        [userId, store, id, json],
        connection,
      );
    }
  });
}

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/session") {
    const user = await getAuthenticatedUser(request);
    const workspace = await get("SELECT user_id FROM workspace WHERE singleton = 1");
    return sendJson(response, 200, { user: user ? {
      firstName: user.first_name,
      lastName: user.last_name,
      storeName: user.store_name,
    } : null, storesConfigured: Boolean(workspace) });
  }

  if (request.method === "POST" && (pathname === "/api/register" || pathname === "/api/login")) {
    requireSameOrigin(request);
    await enforceRateLimit(request, pathname);
    const body = await readJson(request);
    validatePassword(body.password);

    if (pathname === "/api/register") {
      validateNewAccessKey(body.password);
      const accessKeyHash = await hashAccessKey(body.password);
      if (await get("SELECT id FROM users WHERE access_key_hash = ?", [accessKeyHash])) {
        throw new HttpError(409, "Esa clave ya pertenece a otra tienda. Crea una clave diferente para esta tienda.");
      }
      for (const legacyUser of await all(
        "SELECT id, first_name, last_name, store_name, password_salt, password_hash FROM users WHERE access_key_hash IS NULL",
      )) {
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
      try {
        await withTransaction(async (connection) => {
          if (await get("SELECT id FROM users WHERE access_key_hash = ?", [accessKeyHash], connection)) {
            throw new HttpError(409, "Esa clave ya pertenece a otra tienda. Crea una clave diferente para esta tienda.");
          }
          await run(
            `INSERT INTO users
             (id, email, first_name, last_name, store_name, password_salt, password_hash, access_key_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              user.id,
              `workspace-${user.id}@mi-negocio.local`,
              user.firstName,
              user.lastName,
              user.storeName,
              salt.toString("hex"),
              passwordHash.toString("hex"),
              accessKeyHash,
              Date.now(),
            ],
            connection,
          );
        });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error.errcode === 2067 || error.code === "ERR_SQLITE_CONSTRAINT_UNIQUE" || error.code === "23505") {
          throw new HttpError(409, "Esa clave ya pertenece a otra tienda. Crea una clave diferente para esta tienda.");
        }
        throw error;
      }
      await createSession(user, response);
      return sendJson(response, 201, { user: {
        firstName,
        lastName,
        storeName,
      } });
    }

    const accessKeyHash = await hashAccessKey(body.password);
    let user = await get(
      "SELECT id, first_name, last_name, store_name, password_salt, password_hash, access_key_hash FROM users WHERE access_key_hash = ?",
      [accessKeyHash],
    );
    let authenticated = false;
    if (!user) {
      for (const legacyUser of await all(
        "SELECT id, first_name, last_name, store_name, password_salt, password_hash, access_key_hash FROM users WHERE access_key_hash IS NULL",
      )) {
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
        await run(
          "UPDATE users SET access_key_hash = ? WHERE id = ? AND access_key_hash IS NULL",
          [accessKeyHash, user.id],
        );
      } catch (error) {
        if (error.errcode === 2067 || error.code === "ERR_SQLITE_CONSTRAINT_UNIQUE" || error.code === "23505") {
          throw new HttpError(401, "La clave especial no es correcta.");
        }
        throw error;
      }
    }
    await createSession(user, response);
    return sendJson(response, 200, { user: {
      firstName: user.first_name,
      lastName: user.last_name,
      storeName: user.store_name,
    } });
  }

  if (request.method === "POST" && pathname === "/api/logout") {
    requireSameOrigin(request);
    const token = requestCookies(request).mi_negocio_session;
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      await run("DELETE FROM sessions WHERE token_hash = ?", [hashToken(token)]);
    }
    return sendJson(response, 200, { ok: true }, { "Set-Cookie": clearedSessionCookie() });
  }

  if (request.method === "GET" && pathname === "/api/data") {
    const user = await requireAuthenticatedUser(request);
    return sendJson(response, 200, { data: await loadData(user.id) });
  }

  if (request.method === "PUT" && pathname === "/api/data") {
    requireSameOrigin(request);
    const user = await requireAuthenticatedUser(request);
    const body = await readJson(request);
    await persistData(user.id, body.data);
    return sendJson(response, 200, { ok: true });
  }

  throw new HttpError(404, "No se encontró este recurso.");
}

async function handleRequest(request, response) {
  return handleApi(request, response, new URL(request.originalUrl, "http://localhost").pathname);
}

app.use((request, response, next) => {
  response.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
  });
  next();
});

app.use(express.json({ limit: "2mb" }));
app.get(["/", "/index.html"], (request, response) => {
  response.sendFile(path.join(root, "index.html"));
});
app.get("/styles.css", (request, response) => {
  response.sendFile(path.join(root, "styles.css"));
});
app.get("/app.js", (request, response) => {
  response.type("text/javascript").sendFile(path.join(root, "app.js"));
});
app.use("/api", (request, response, next) => {
  Promise.resolve(handleRequest(request, response)).catch(next);
});
app.use("/api", (request, response) => {
  sendJson(response, 404, { error: "No se encontró este recurso." });
});
app.use((request, response, next) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return next(new HttpError(405, "Método no permitido."));
  }
  next(new HttpError(404, "No se encontró esta página."));
});
app.use((error, request, response, next) => {
  if (response.headersSent) return next(error);
  if (error instanceof HttpError) {
    return sendJson(response, error.status, { error: error.message });
  }
  if (error.type === "entity.too.large") {
    return sendJson(response, 413, { error: "La solicitud es demasiado grande." });
  }
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return sendJson(response, 400, { error: "El contenido JSON no es válido." });
  }
  console.error("Error procesando una solicitud:", error);
  return sendJson(response, 500, { error: "Ocurrió un error interno. Inténtalo de nuevo." });
});

function listenServer() {
  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`Mi negocio disponible en http://localhost:${port}`);
  });
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && port < 65535) {
      const occupiedPort = port;
      port += 1;
      console.warn(`El puerto ${occupiedPort} ya está en uso. Probando el puerto ${port}...`);
      listenServer();
      return;
    }

    console.error("No se pudo iniciar el servidor:", error);
    process.exitCode = 1;
  });
}

async function startServer() {
  try {
    await initializeDatabase();
    listenServer();
  } catch (error) {
    console.error("No se pudo preparar la base de datos:", error);
    process.exitCode = 1;
    if (postgresUrl) await database.end();
  }
}

startServer();
