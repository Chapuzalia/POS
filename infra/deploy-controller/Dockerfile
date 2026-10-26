# Both services are built and managed by the same Coolify Compose application.
FROM docker:29-cli AS docker-cli

FROM node:24.12.0-bookworm-slim AS source
WORKDIR /opt/tickit
COPY --chown=0:0 --chmod=0644 apps/deploy-controller/package.json ./apps/deploy-controller/package.json
COPY --chown=0:0 apps/deploy-controller/src/ /opt/tickit/apps/deploy-controller/src/

RUN test -f /opt/tickit/apps/deploy-controller/src/gateway.ts \
 && test -f /opt/tickit/apps/deploy-controller/src/worker.ts


RUN chmod 0755 /opt/tickit \
    /opt/tickit/apps \
    /opt/tickit/apps/deploy-controller \
    /opt/tickit/apps/deploy-controller/src \
 && find /opt/tickit/apps/deploy-controller/src \
    -type d -exec chmod 0755 {} + \
 && find /opt/tickit/apps/deploy-controller/src \
    -type f -exec chmod 0644 {} +
    

FROM source AS api
USER 10001:2010
RUN test -r /opt/tickit/apps/deploy-controller/src/gateway.ts \
 && test -r /opt/tickit/apps/deploy-controller/src/http.ts
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health',{signal:AbortSignal.timeout(3000)}).then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "/opt/tickit/apps/deploy-controller/src/gateway.ts"]

FROM source AS worker
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client python3 util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && mv /usr/local/bin/node /usr/bin/node \
    && ln -s /usr/bin/node /usr/local/bin/node
COPY --from=docker-cli /usr/local/bin/docker /usr/bin/docker
# Supabase CLI 2.121.0 release asset hashes, pinned independently of the download.
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=amd64; checksum=4b481189efbdc57cf2d37bdee5f1a0d29574314398564b32a6dfb76c0fcf275f ;; \
      arm64) arch=arm64; checksum=896278173cd7c3632e9340e546129606a26e696e90bcaaa6f7b7490fe218efc7 ;; \
      *) exit 1 ;; \
    esac; \
    curl --fail --silent --show-error --location --retry 3 \
      "https://github.com/supabase/cli/releases/download/v2.121.0/supabase_2.121.0_linux_${arch}.tar.gz" -o /tmp/supabase.tar.gz; \
    printf '%s  /tmp/supabase.tar.gz\n' "$checksum" | sha256sum --check --status; \
    tar -xzf /tmp/supabase.tar.gz -C /usr/bin supabase; \
    chmod 0755 /usr/bin/supabase; \
    rm /tmp/supabase.tar.gz; \
    test "$(/usr/bin/supabase --version)" = 2.121.0
COPY --chown=0:0 --chmod=0644 scripts/controller-package.py scripts/start-deploy-worker.py \
    scripts/deploy-pos.py scripts/deploy-backup-retention.py scripts/deploy-coolify.mjs \
    scripts/prepare-production-migrations.mjs scripts/prepare-edge-functions.mjs \
    scripts/edge-router.ts scripts/pending-migration-safety.mjs scripts/check-migrations.mjs ./scripts/
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const r=require('node:http').get({socketPath:'/run/tickit-deploy/worker.sock',path:'/health'},s=>{s.resume();if(s.statusCode!==200)process.exit(1)});r.setTimeout(3000,()=>{r.destroy();process.exit(1)});r.on('error',()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/python3", "-B", "/opt/tickit/scripts/start-deploy-worker.py"]
CMD []
