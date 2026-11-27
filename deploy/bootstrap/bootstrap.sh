#!/bin/bash
# Prepares a fresh self-hosted Flagsmith for the Alibi example, and can be run again safely:
# every step looks for what it would create before it creates it.
#
# It writes what the other services need to /shared/flagsmith.env and /shared/flagsmith.json.
set -euo pipefail

BASE="${FLAGSMITH_INTERNAL_URL:-http://flagsmith:8000}"
API="$BASE/api/v1"
SHARED=/shared
ADMIN_EMAIL=admin@alibi.example
ORG_NAME=Alibi
PROJECT_NAME=shop
ENV_NAME=Development
FLAG=checkout_v2
STABLE=stable
VARIATION=v2
EXPERIMENT_NAME="checkout_v2 rollout"

set -a
. "$SHARED/secrets.env"
set +a

say() { echo "bootstrap: $*"; }

# call METHOD PATH [JSON BODY] prints the response body and fails on a non-2xx status.
call() {
  local method=$1 path=$2 body=${3:-} out status
  out=$(mktemp)
  if [ -n "$body" ]; then
    status=$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$API/$path" \
      -H "Authorization: Token $TOKEN" -H 'Content-Type: application/json' -d "$body")
  else
    status=$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$API/$path" \
      -H "Authorization: Token $TOKEN" -H 'Content-Type: application/json')
  fi
  if [[ "$status" != 2* ]]; then
    echo "bootstrap: $method $path answered $status: $(head -c 400 "$out")" >&2
    return 1
  fi
  cat "$out"
}

# items turns a list answer, paged or not, into a plain array.
items() { jq 'if type == "array" then . else (.results // []) end'; }

say "waiting for Flagsmith at $BASE"
for _ in $(seq 1 90); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health/liveness/")" = 200 ] && break
  sleep 2
done

say "admin user"
if [ "$(curl -s "$BASE/version/" | jq -r '.self_hosted_data.has_users')" = false ]; then
  curl -fsS -o /dev/null -X POST "$API/auth/users/" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" \
      '{email:$e,password:$p,re_password:$p,first_name:"Alibi",last_name:"Admin",superuser:true}')"
fi
TOKEN=$(curl -fsS -X POST "$API/auth/login/" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email:$e,password:$p}')" | jq -r .key)

say "organisation"
ORG_ID=$(call GET organisations/ | items | jq -r --arg n "$ORG_NAME" '[.[] | select(.name == $n)][0].id // empty')
[ -n "$ORG_ID" ] || ORG_ID=$(call POST organisations/ "$(jq -n --arg n "$ORG_NAME" '{name:$n}')" | jq -r .id)

say "project"
PROJECT_ID=$(call GET "projects/?organisation=$ORG_ID" | items | jq -r --arg n "$PROJECT_NAME" '[.[] | select(.name == $n)][0].id // empty')
[ -n "$PROJECT_ID" ] || PROJECT_ID=$(call POST projects/ "$(jq -n --arg n "$PROJECT_NAME" --argjson o "$ORG_ID" '{name:$n,organisation:$o}')" | jq -r .id)

say "environment"
ENV_KEY=$(call GET "environments/?project=$PROJECT_ID" | items | jq -r --arg n "$ENV_NAME" '[.[] | select(.name == $n)][0].api_key // empty')
[ -n "$ENV_KEY" ] || ENV_KEY=$(call POST environments/ "$(jq -n --arg n "$ENV_NAME" --argjson p "$PROJECT_ID" '{name:$n,project:$p}')" | jq -r .api_key)

say "server-side key for the shop"
SERVER_KEY=$(call GET "environments/$ENV_KEY/api-keys/" | items | jq -r '[.[] | select(.name == "shop" and .active != false)][0].key // empty')
[ -n "$SERVER_KEY" ] || SERVER_KEY=$(call POST "environments/$ENV_KEY/api-keys/" '{"name":"shop"}' | jq -r .key)

say "master API key for Alibi"
MASTER_KEY=""
if [ -f "$SHARED/flagsmith.env" ]; then
  MASTER_KEY=$(sed -n 's/^FLAGSMITH_MASTER_KEY=//p' "$SHARED/flagsmith.env")
  # A key left over from a Flagsmith database that was deleted no longer works: make a new one.
  if [ -n "$MASTER_KEY" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Api-Key $MASTER_KEY" "$API/organisations/")" != 200 ]; then
    MASTER_KEY=""
  fi
fi
if [ -z "$MASTER_KEY" ]; then
  MASTER_KEY=$(call POST "organisations/$ORG_ID/master-api-keys/" \
    "$(jq -n --arg n "alibi-$(date +%s)" --argjson o "$ORG_ID" '{name:$n,organisation:$o,is_admin:true}')" | jq -r .key)
fi

say "feature $FLAG"
FEATURE_ID=$(call GET "projects/$PROJECT_ID/features/?search=$FLAG" | items | jq -r --arg n "$FLAG" '[.[] | select(.name == $n)][0].id // empty')
if [ -z "$FEATURE_ID" ]; then
  FEATURE_ID=$(call POST "projects/$PROJECT_ID/features/" \
    "$(jq -n --arg n "$FLAG" --arg v "$STABLE" '{name:$n,type:"STANDARD",default_enabled:true,initial_value:$v}')" | jq -r .id)
fi
OPTION_ID=$(call GET "projects/$PROJECT_ID/features/$FEATURE_ID/mv-options/" | items | jq -r --arg k "$VARIATION" '[.[] | select(.key == $k)][0].id // empty')
if [ -z "$OPTION_ID" ]; then
  OPTION_ID=$(call POST "projects/$PROJECT_ID/features/$FEATURE_ID/mv-options/" \
    "$(jq -n --arg k "$VARIATION" --argjson f "$FEATURE_ID" '{feature:$f,type:"unicode",string_value:$k,key:$k,default_percentage_allocation:0}')" | jq -r .id)
fi

say "warehouse connection"
if [ "$(call GET "environments/$ENV_KEY/warehouse-connections/" | items | jq length)" = 0 ]; then
  call POST "environments/$ENV_KEY/warehouse-connections/" \
    '{"warehouse_type":"postgres","config":{"source":"flagsmith_database"}}' > /dev/null
fi

# metric NAME AGGREGATION DIRECTION prints the metric id, creating the metric when it is missing.
metric() {
  local id
  id=$(call GET "environments/$ENV_KEY/experiment-metrics/" | items | jq -r --arg n "$1" '[.[] | select(.name == $n)][0].id // empty')
  if [ -z "$id" ]; then
    id=$(call POST "environments/$ENV_KEY/experiment-metrics/" \
      "$(jq -n --arg n "$1" --arg a "$2" --arg d "$3" '{name:$n,aggregation:$a,direction:$d,definition:{version:1,event:$n}}')" | jq -r .id)
  fi
  echo "$id"
}
say "metrics"
M_COMPLETED=$(metric checkout_completed occurrence up)
M_FAILURE=$(metric flag_path_failure occurrence down)
M_LATENCY=$(metric checkout_latency_ms mean down)

say "experiment"
# A completed experiment cannot be started again, so a new one takes its place under a numbered name.
EXPERIMENTS=$(call GET "environments/$ENV_KEY/experiments/" | items | jq --arg n "$EXPERIMENT_NAME" '[.[] | select(.name | startswith($n))]')
EXPERIMENT_ID=$(jq -r '[.[] | select(.status != "completed")][0].id // empty' <<< "$EXPERIMENTS")
if [ -z "$EXPERIMENT_ID" ]; then
  RUNS=$(jq length <<< "$EXPERIMENTS")
  NEW_NAME=$EXPERIMENT_NAME
  [ "$RUNS" = 0 ] || NEW_NAME="$EXPERIMENT_NAME $((RUNS + 1))"
  EXPERIMENT_ID=$(call POST "environments/$ENV_KEY/experiments/" "$(jq -n \
    --argjson f "$FEATURE_ID" --arg n "$NEW_NAME" --arg s "$STABLE" --argjson o "$OPTION_ID" \
    --argjson m1 "$M_COMPLETED" --argjson m2 "$M_FAILURE" --argjson m3 "$M_LATENCY" '{
      feature: $f,
      name: $n,
      hypothesis: "The new checkout completes at least as many orders as the stable one, with fewer failures on its own path and no slower.",
      metrics: [
        {metric: $m1, expected_direction: "increase"},
        {metric: $m2, expected_direction: "decrease"},
        {metric: $m3, expected_direction: "decrease"}
      ],
      experiment_rollout: {
        enabled: true,
        rollout_percentage: 100,
        feature_state_value: {type: "string", value: $s},
        multivariate_feature_state_values: [{multivariate_feature_option: $o, percentage_allocation: 50}]
      }
    }')" | jq -r .id)
fi
if [ "$(call GET "environments/$ENV_KEY/experiments/$EXPERIMENT_ID/" | jq -r .status)" != running ]; then
  call POST "environments/$ENV_KEY/experiments/$EXPERIMENT_ID/start/" > /dev/null
fi

say "writing $SHARED/flagsmith.env and flagsmith.json"
cat > "$SHARED/flagsmith.env.tmp" <<EOF
FLAGSMITH_URL=http://127.0.0.1:8000
FLAGSMITH_INTERNAL_URL=http://flagsmith:8000
FLAGSMITH_ENVIRONMENT_KEY=$ENV_KEY
FLAGSMITH_SERVER_KEY=$SERVER_KEY
FLAGSMITH_MASTER_KEY=$MASTER_KEY
FLAGSMITH_ORG_ID=$ORG_ID
FLAGSMITH_PROJECT_ID=$PROJECT_ID
FLAGSMITH_FEATURE_ID=$FEATURE_ID
FLAGSMITH_EXPERIMENT_ID=$EXPERIMENT_ID
EOF
jq -n --arg u http://127.0.0.1:8000 --arg i http://flagsmith:8000 --arg ek "$ENV_KEY" --arg sk "$SERVER_KEY" --arg mk "$MASTER_KEY" \
  --arg flag "$FLAG" --arg stable "$STABLE" --arg variation "$VARIATION" \
  --argjson org "$ORG_ID" --argjson project "$PROJECT_ID" --argjson feature "$FEATURE_ID" \
  --argjson option "$OPTION_ID" --argjson experiment "$EXPERIMENT_ID" \
  --argjson m1 "$M_COMPLETED" --argjson m2 "$M_FAILURE" --argjson m3 "$M_LATENCY" '{
    url: $u, internalUrl: $i, environmentKey: $ek, serverKey: $sk, masterKey: $mk,
    organisationId: $org, projectId: $project, flag: $flag, featureId: $feature,
    stableVariation: $stable, variation: $variation, variationOptionId: $option,
    experimentId: $experiment,
    metrics: {checkout_completed: $m1, flag_path_failure: $m2, checkout_latency_ms: $m3}
  }' > "$SHARED/flagsmith.json.tmp"
chmod 644 "$SHARED"/flagsmith.env.tmp "$SHARED"/flagsmith.json.tmp
mv "$SHARED/flagsmith.env.tmp" "$SHARED/flagsmith.env"
mv "$SHARED/flagsmith.json.tmp" "$SHARED/flagsmith.json"
say "done"
