#!/bin/sh
# Disposable local PostgreSQL checks; does not contact the live Supabase project.
set -eu
cd "$(dirname "$0")/.."
MOA_TEST_CONTAINER="moa-db-test-$$"
export MOA_TEST_CONTAINER
trap 'docker rm -f "$MOA_TEST_CONTAINER" >/dev/null 2>&1 || true' EXIT INT TERM
docker run -d --rm --name "$MOA_TEST_CONTAINER" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine >/dev/null
attempt=0
until docker exec "$MOA_TEST_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then echo 'Local test database did not start' >&2; exit 1; fi
  sleep 1
done
docker exec "$MOA_TEST_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -c 'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;'
docker exec -i "$MOA_TEST_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 < supabase/setup.sql
# Reapply to check that existing data/schema are preserved.
docker exec -i "$MOA_TEST_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 < supabase/setup.sql
docker exec -i "$MOA_TEST_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests.sql
if [ "${MOA_BROWSER_TEST:-0}" = 1 ]; then python3 tests/supabase-browser-smoke.py; fi
