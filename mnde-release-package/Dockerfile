FROM node:24-bookworm-slim

WORKDIR /opt/mnde
COPY . /opt/mnde

ENV MNDE_BIND_ADDR=0.0.0.0:8787
ENV MNDE_LOCAL_DIR=/var/lib/mnde
ENV MNDE_POLICY_FILE=/var/lib/mnde/policy.v1.signed.json
ENV MNDE_CLIENT_KEYS=/var/lib/mnde/client_keys.json
ENV MNDE_RECEIPT_LOG=/var/lib/mnde/receipts.jsonl
ENV MNDE_SIDECAR_LOG=/var/log/mnde/sidecar.jsonl
ENV MNDE_PINNED_POLICY_VERSION=policy.v1

RUN mkdir -p /var/lib/mnde /var/log/mnde \
    && node /opt/mnde/app/sidecar/create-local-fixtures.js /var/lib/mnde

EXPOSE 8787
ENTRYPOINT ["node", "/opt/mnde/app/sidecar/server.js"]

