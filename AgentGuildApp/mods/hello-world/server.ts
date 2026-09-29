import { defineServerMod } from "@swarm/sdk";

let logins = 0;

export default defineServerMod({
  setup(ctx) {
    ctx.log.info("loaded");
  },

  routes: {
    // Signed-in users only (the default).
    "GET /stats": (_req, { session }) => ({ hello: session?.address, logins }),
    // Opt in to anonymous access explicitly.
    "GET /about": { public: true, handler: () => ({ name: "hello-world", version: "1.0.0" }) },
    "GET /echo/:word": (_req, { params }) => ({ echo: params.word }),
  },

  events: {
    // Requires the "events:subscribe" permission in swarm.mod.json.
    "auth.login": ({ address }, ctx) => {
      logins += 1;
      ctx.log.info(`login #${logins}: ${address}`);
    },
  },
});
