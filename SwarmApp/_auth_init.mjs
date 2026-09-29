import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import fs from "fs";

const targetKey = JSON.parse(fs.readFileSync("/tmp/claude-1000/-home-god-Desktop-swarmcore/950bf3be-826d-48bd-8c7b-09faad885a80/scratchpad/agent-guild-migration-sa.json", "utf8"));
const app = initializeApp({ credential: cert(targetKey), projectId: "agent-guild" });
const auth = getAuth(app);

try {
  const user = await auth.createUser({ email: "init-probe@agent-guild.example", password: "TemporaryInit123!" });
  console.log("Created probe user:", user.uid);
  await auth.deleteUser(user.uid);
  console.log("Deleted probe user OK — auth config is initialized");
} catch (e) {
  console.error("createUser failed:", e.message);
}
