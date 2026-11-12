#!/bin/sh
set -eu

image="miko-hub-phase-zero-smoke-$$"
container="miko-hub-phase-zero-smoke-$$"
database="miko-hub-phase-zero-postgres-$$"
network="miko-hub-phase-zero-smoke-$$"
smoke_password="local-smoke-postgres"

cleanup() {
  docker stop "$container" "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

docker build --tag "$image" .
if [ -n "${DOCKER_SMOKE_SUBNET:-}" ]; then
  docker network create --subnet "$DOCKER_SMOKE_SUBNET" "$network" >/dev/null
else
  docker network create "$network" >/dev/null
fi
docker run --detach --rm --cpus 1 --memory 512m --name "$database" --network "$network" \
  --env "POSTGRES_PASSWORD=$smoke_password" \
  --env POSTGRES_DB=miko_hub \
  postgres:17-alpine >/dev/null

attempt=0
until docker exec "$database" pg_isready --username postgres --dbname miko_hub >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker logs "$database"
    exit 1
  fi
  sleep 1
done

docker run --detach --rm --cpus 1 --memory 768m --name "$container" --network "$network" \
  --env "DATABASE_URL=postgres://postgres:$smoke_password@$database:5432/miko_hub" \
  --publish 127.0.0.1::3000 \
  "$image" >/dev/null

port="$(docker port "$container" 3000/tcp | sed 's/.*://')"
attempt=0
until curl --fail --silent "http://127.0.0.1:$port/health" | grep --quiet '"ok":true'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker logs "$container"
    exit 1
  fi
  sleep 1
done
