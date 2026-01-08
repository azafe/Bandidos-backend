#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3001}"

create_and_get_id() {
  local endpoint="$1"
  local payload="$2"

  local response
  response="$(curl -sS -X POST "${BASE_URL}${endpoint}" \
    -H "Content-Type: application/json" \
    -d "${payload}")"

  local id
  if ! id="$(node -e "const fs=require('fs');const input=fs.readFileSync(0,'utf8').trim();if(!input){process.exit(2);}let data;try{data=JSON.parse(input);}catch{process.exit(3);}if(!data.id){process.exit(4);}console.log(data.id);" <<<"${response}")"; then
    echo "Failed to create ${endpoint}. Response:"
    echo "${response}"
    exit 1
  fi

  echo "${id}"
}

customer_id="$(create_and_get_id "/v2/customers" '{
  "name": "Carlos Perez",
  "phone": "1122334455",
  "email": "carlos@example.com",
  "notes": "Cliente nuevo"
}')"
echo "customer_id=${customer_id}"

pet_id="$(create_and_get_id "/v2/pets" "{
  \"customer_id\": \"${customer_id}\",
  \"name\": \"Luna\",
  \"breed\": \"Caniche\",
  \"size\": \"Mediana\",
  \"notes\": \"Nails trim\"
}")"
echo "pet_id=${pet_id}"

service_type_id="$(create_and_get_id "/v2/service-types" '{
  "name": "Grooming",
  "default_price": 35
}')"
echo "service_type_id=${service_type_id}"

payment_method_id="$(create_and_get_id "/v2/payment-methods" '{
  "name": "Cash"
}')"
echo "payment_method_id=${payment_method_id}"

groomer_id="$(create_and_get_id "/v2/employees" '{
  "name": "Ana",
  "role": "Groomer",
  "phone": "1133221100",
  "email": "ana@example.com",
  "status": "active",
  "notes": null
}')"
echo "groomer_id=${groomer_id}"

service_response="$(curl -sS -X POST "${BASE_URL}/services" \
  -H "Content-Type: application/json" \
  -d "{
    \"date\": \"2024-10-05\",
    \"pet_id\": \"${pet_id}\",
    \"customer_id\": \"${customer_id}\",
    \"service_type_id\": \"${service_type_id}\",
    \"price\": 35,
    \"payment_method_id\": \"${payment_method_id}\",
    \"groomer_id\": \"${groomer_id}\",
    \"notes\": \"Nails trim\"
  }")"

echo "service_response=${service_response}"
