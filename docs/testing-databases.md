# Testing the database bridge against real servers

The guard, masking, formatting and connection-string parsers are covered by unit tests without any server. The
drivers are tested against real servers by `tests/integration/databases.test.ts` (and, through the built app, by
`tests/e2e/database-engines.spec.ts`) when their URLs are set; otherwise those tests are skipped and only SQLite runs.

Start the servers with Docker (any recent versions work):

```sh
docker run -d --name oxy-pg -e POSTGRES_PASSWORD=Secret_pw1 -e POSTGRES_DB=bank -p 55432:5432 postgres:17-alpine
docker run -d --name oxy-mysql -e MYSQL_ROOT_PASSWORD=Secret_pw1 -e MYSQL_DATABASE=bank -p 53306:3306 mysql:8.4
docker run -d --name oxy-maria -e MARIADB_ROOT_PASSWORD=Secret_pw1 -e MARIADB_DATABASE=bank -p 53307:3306 mariadb:11
docker run -d --name oxy-mssql -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD=Secret_pw1 -p 51433:1433 mcr.microsoft.com/mssql/server:2022-latest
docker run -d --name oxy-mongo -e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD=Secret_pw1 -p 57017:27017 mongo:8
docker run -d --name oxy-redis -p 56379:6379 redis:7-alpine redis-server --requirepass Secret_pw1
docker run -d --name oxy-ch -e CLICKHOUSE_PASSWORD=Secret_pw1 -e CLICKHOUSE_DB=bank -p 58123:8123 clickhouse/clickhouse-server:25.8-alpine
docker run -d --name oxy-oracle -e ORACLE_PASSWORD=Secret_pw1 -e APP_USER=bank -e APP_USER_PASSWORD=Secret_pw1 -p 51521:1521 gvenzl/oracle-free:23-slim-faststart
```

Each SQL database needs a `users` table (`id`, `email`, `password_hash`) with at least 20 rows — ClickHouse an
`events` table (`ts`, `user_id`, `kind`, `duration`), MongoDB a `users` collection (`email`, `passwordHash`,
`profile.apiToken`), Redis a few `user:<n>:name` strings and `session:<n>` hashes with a `token` field.

```sh
export OXY_TEST_PG_URL='postgres://postgres:Secret_pw1@127.0.0.1:55432/bank'
export OXY_TEST_MYSQL_URL='mysql://root:Secret_pw1@127.0.0.1:53306/bank'
export OXY_TEST_MARIADB_URL='mariadb://root:Secret_pw1@127.0.0.1:53307/bank'
export OXY_TEST_MSSQL_URL='sqlserver://sa:Secret_pw1@127.0.0.1:51433/bank?trustServerCertificate=true'
export OXY_TEST_MONGO_URL='mongodb://root:Secret_pw1@127.0.0.1:57017/bank?authSource=admin'
export OXY_TEST_REDIS_URL='redis://:Secret_pw1@127.0.0.1:56379'
export OXY_TEST_CLICKHOUSE_URL='clickhouse://default:Secret_pw1@127.0.0.1:58123/bank'
export OXY_TEST_ORACLE_URL='oracle://bank:Secret_pw1@127.0.0.1:51521/FREEPDB1'
npx vitest run --project integration tests/integration/databases.test.ts
```
