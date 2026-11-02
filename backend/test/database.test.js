// Tests de la configuración de SSL de la conexión a Postgres (no se conecta a ninguna base)
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const CONFIG = require.resolve("../config/database");
const saved = { ...process.env };

// El archivo arma la conexión al cargarse: se vuelve a cargar con cada entorno
const dialectOptions = (env) => {
  process.env.DATABASE_URL = "postgres://u:p@localhost:5432/test";
  process.env.DB_SSL = "";
  process.env.NODE_ENV = "test";
  Object.assign(process.env, env);
  delete require.cache[CONFIG];
  return require(CONFIG).sequelize.options.dialectOptions;
};

afterEach(() => {
  process.env = { ...saved };
});

test("sin DB_SSL la conexión a Postgres sigue yendo con SSL", () => {
  assert.ok(dialectOptions({}).ssl);
  assert.ok(dialectOptions({ DB_SSL: "true" }).ssl);
});

test("DB_SSL=false desactiva el SSL para un Postgres local", () => {
  assert.equal(dialectOptions({ DB_SSL: "false" }).ssl, undefined);
});

test("en producción DB_SSL=false se ignora", () => {
  const { ssl } = dialectOptions({ DB_SSL: "false", NODE_ENV: "production" });
  assert.ok(ssl);
  assert.equal(ssl.require, true);
});

test("con SQLite no se usa SSL", () => {
  assert.equal(dialectOptions({ DATABASE_URL: "sqlite::memory:" }).ssl, undefined);
});
