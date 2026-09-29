import { defineRailway, github, project, redis, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Redis = redis("Redis", { region: "us-east4-eqdc4a" });
  Redis.deploy = { startCommand: "/bin/sh -c \"rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH\"" };
  Redis.networking = { privateNetworkEndpoint: "redis" };
  const redisVolume = volume("redis-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-east4-eqdc4a", sizeMB: 5000 });
  const agentGuildHub = service("agent-guild-hub", {
    source: github("SwarmProtocol-fun/agent-guild", { rootDirectory: "hub" }),
    replicas: { "us-east4-eqdc4a": 1 },
    deploy: { healthcheckPath: "/health" },
  });

  return project("agent-guild", {
    resources: [agentGuildHub, Redis, redisVolume],
  });
});
