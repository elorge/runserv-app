#!/usr/bin/env sh
# Build the OSRM routing graph for Nigeria. Needs Docker, ~10 GB free disk and a few GB of RAM.
set -eu
mkdir -p data && cd data
[ -f nigeria-latest.osm.pbf ] || wget -O nigeria-latest.osm.pbf https://download.geofabrik.de/africa/nigeria-latest.osm.pbf
IMG=osrm/osrm-backend:latest
docker run --rm -t -v "$PWD:/data" $IMG osrm-extract   -p /opt/car.lua /data/nigeria-latest.osm.pbf
docker run --rm -t -v "$PWD:/data" $IMG osrm-partition /data/nigeria-latest.osrm
docker run --rm -t -v "$PWD:/data" $IMG osrm-customize /data/nigeria-latest.osrm
echo "Done. Now: docker compose up -d"
