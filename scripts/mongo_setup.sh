#!/usr/bin/env bash

set -euo pipefail

for attempt in $(seq 1 30); do
  if mongosh --host devicehub-mongo:27017 --quiet --eval '
    const status = db.adminCommand({ replSetGetStatus: 1 });
    if (status.ok === 1) {
      print("Replica set already initialized");
      quit(0);
    }
  ' 2>/dev/null; then
    exit 0
  fi

  if mongosh --host devicehub-mongo:27017 --quiet --eval '
    rs.initiate({
      _id: "devicehub-rs",
      members: [{ _id: 0, host: "devicehub-mongo:27017", priority: 2 }]
    })
  ' 2>/dev/null; then
    exit 0
  fi

  echo "MongoDB is not ready; retrying ($attempt/30)"
  sleep 2
done

echo "Unable to initialize MongoDB replica set" >&2
exit 1
