const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Pool } = require("pg");

const sqlitePath = process.env.SQLITE_PATH || path.join(__dirname, "..", "data", "mi-negocio.sqlite");
const postgresUrl = process.env.DATABASE_URL;

if (!postgresUrl) {
  throw new Error("Configura DATABASE_URL con la dirección de conexión PostgreSQL antes de migrar.");
}

const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
const postgres = new Pool({ connectionString: postgresUrl, max: 1 });

async function migrate() {
  const users = sqlite.prepare("SELECT * FROM users").all();
  const records = sqlite.prepare("SELECT * FROM app_data").all();
  const workspace = sqlite.prepare("SELECT singleton, user_id FROM workspace").all();
  const connection = await postgres.connect();

  try {
    await connection.query(`
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

    await connection.query("BEGIN");
    const existing = await connection.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM app_data) AS app_data,
        (SELECT COUNT(*) FROM workspace) AS workspace
    `);
    if (Object.values(existing.rows[0]).some((count) => Number(count) > 0)) {
      throw new Error("La base PostgreSQL ya contiene datos. Se canceló la migración para evitar sobrescribirlos.");
    }

    for (const user of users) {
      await connection.query(
        `INSERT INTO users
         (id, email, password_salt, password_hash, created_at, first_name, last_name, store_name, access_key_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          user.id,
          user.email,
          user.password_salt,
          user.password_hash,
          user.created_at,
          user.first_name || "",
          user.last_name || "",
          user.store_name || "Mi negocio",
          user.access_key_hash || null,
        ],
      );
    }

    for (const record of records) {
      await connection.query(
        "INSERT INTO app_data (user_id, store_name, record_id, record_json) VALUES ($1, $2, $3, $4)",
        [record.user_id, record.store_name, record.record_id, record.record_json],
      );
    }

    for (const row of workspace) {
      await connection.query(
        "INSERT INTO workspace (singleton, user_id) VALUES ($1, $2)",
        [row.singleton, row.user_id],
      );
    }

    await connection.query("COMMIT");
    console.log(`Migración terminada: ${users.length} tiendas y ${records.length} registros copiados.`);
    console.log("Las sesiones no se copiaron; vuelve a iniciar sesión en la aplicación después del despliegue.");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

migrate()
  .catch((error) => {
    console.error("No se pudo migrar SQLite a PostgreSQL:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    sqlite.close();
    await postgres.end();
  });
