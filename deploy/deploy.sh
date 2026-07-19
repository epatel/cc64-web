#!/bin/sh
# Deploy cc64-web to rpi6 (https://rpi6.memention.net/cc64-web/).
# Syncs the static subset the IDE needs + the python server, installs the
# systemd unit and the apache endpoints.d snippet, restarts both.
set -e
cd "$(dirname "$0")/.."

rsync -aR --delete \
  web src assets server deploy test/fixtures \
  examples/raytracer/raytracer.cc64proj.json \
  examples/boing/boing.cc64proj.json \
  examples/ghosts/ghosts.cc64proj.json \
  examples/sideborders/sideborders.cc64proj.json \
  examples/sideborders2/sideborders2.cc64proj.json \
  examples/mandelbrot/mandelbrot.cc64proj.json \
  rpi6:cc64-web/

ssh rpi6 '
  sudo cp ~/cc64-web/deploy/cc64-web.service /etc/systemd/system/cc64-web.service &&
  sudo cp ~/cc64-web/deploy/cc64-web.endpoints.conf /etc/apache2/endpoints.d/cc64-web.conf &&
  sudo systemctl daemon-reload &&
  sudo systemctl enable --now cc64-web >/dev/null 2>&1 &&
  sudo systemctl restart cc64-web &&
  sudo apache2ctl configtest &&
  sudo apache2ctl graceful &&
  sleep 1 &&
  curl -sf http://localhost:9007/cc64-web/api/ping && echo " local ok"
'
echo "deployed: https://rpi6.memention.net/cc64-web/"
