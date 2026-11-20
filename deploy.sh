#!/usr/bin/env bash
# Push code to the csincsi host and restart the container. Never touches the host's
# data/ (live database) or .env (credentials).
set -euo pipefail
cd "$(dirname "$0")"

rsync -az --delete \
  --exclude node_modules/ --exclude data/ --exclude .git/ --exclude .env \
  --exclude '*.csv' --exclude '*.xls' --exclude '*.xlsx' \
  ./ csincsi:/root/portfolio/

ssh csincsi 'chown -R root:root /root/portfolio && cd /root/csincsi-infra && since=$(date +%s) && docker-compose restart portfolio >/dev/null \
  && for i in $(seq 1 40); do docker logs --since $since csincsi-infra_portfolio_1 2>&1 | grep -q "portfolio on" && exit 0; sleep 3; done; \
  echo "container did not come up:"; docker logs --tail 30 csincsi-infra_portfolio_1; exit 1'

echo "deployed: https://portfolio.mormota.xyz"
