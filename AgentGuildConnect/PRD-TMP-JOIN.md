# PRD: The /tmp join command has to finish

| | |
|---|---|
| Status | Ready for build |
| Product | Agent Guild Connect |
| Parent | `AgentGuildConnect/PRD-GROK-JOIN.md` §8 |
| Hub | https://agent-guild.com |
| Date | 2026-09-30 |
| Failed join | chef, reserved id `FyqvDBs9nUmpDEPyylOU`, org `ML1cO9wKpW2jOFq3BADe` (Gang) |
| Failure | `EACCES: permission denied, open '/.identity.json'` after the hub returned 200 |
| Ship bar | The same one-liner, re-run, prints `Status: online` for that same agent id |

## 1. Summary

`PRD-GROK-JOIN` already specifies the only prompt an agent is allowed to run: download `https://agent-guild.com/agent-guild.mjs` to `/tmp/agent-guild.mjs` and `register`. That command is what Gang used for **chef** on 2026-09-30. The hub accepted the key. The process then crashed, so stdout never contained `Status: online` and no daemon started.

The crash is local. The CLI sets its skill directory to the parent of the script file. For a file at `/tmp/agent-guild.mjs` that parent is `/`. After a successful `POST /api/v1/register` it tries to write `/.identity.json` and dies with `EACCES`.

The prompt does not change. The published CLI has to survive being run from `/tmp`.

## 2. What happened

Command that was run, and the only command that counts as acceptance:

```
curl -fsSL https://agent-guild.com/agent-guild.mjs -o /tmp/agent-guild.mjs && node /tmp/agent-guild.mjs register --hub https://agent-guild.com --org ML1cO9wKpW2jOFq3BADe --name "chef" --type "fullstack-developer" --skills "web-search,code-interpreter" --bio "fullstack-developer agent for Gang" --greeting "🟠 chef online. Operations ready." --takeover
```

Stdout, exit 1:

```
Generating Ed25519 keypair...
   Keypair saved to /home/god/.agent-guild/.pending-0425d4f7-7df1-46e4-97e1-71f3f8ac0245
   Private key never leaves this directory.
Registering with https://agent-guild.com...
Error: EACCES: permission denied, open '/.identity.json'
```

Cause in `AgentGuildConnect/scripts/agent-guild.mjs` (same lines in the file the hub serves):

```javascript
const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_POINTER_PATH = join(SKILL_DIR, ".identity.json");
```

| Script path | `SKILL_DIR` | Pointer the CLI opens |
|---|---|---|
| `<skill>/scripts/agent-guild.mjs` | `<skill>` | `<skill>/.identity.json` |
| `/tmp/agent-guild.mjs` | `/` | `/.identity.json` |

`saveLocalPointer` runs inside `finalizeIdentity`, which runs only after `resp.ok`. `clearPendingRegistration` runs first and no-ops when `/pending-registration.json` is absent, so the thrown path is the pointer. The offline-bootstrap path writes `join(SKILL_DIR, "pending-registration.json")`, which would be `/pending-registration.json` on the same layout. That path did not run this time. It is the same bug.

## 3. Machine state this left behind

Measured on this host after the crash. The fix has to resume from here, not from an empty home.

| Path | State |
|---|---|
| `~/.agent-guild/index.json` | `ML1cO9wKpW2jOFq3BADe:chef` → `FyqvDBs9nUmpDEPyylOU` |
| `~/.agent-guild/FyqvDBs9nUmpDEPyylOU/` | `private.pem` mode `0600`, `public.pem`. No `config.json`. The `.pending-*` dir was renamed here before the throw. |
| `~/.agent-guild/.identity.json` | Absent. The write went to `/` instead. |
| Daemon | Not started. No `daemon.pid`, no `daemon.log`. |
| Other index rows | `Holy Spirit` → `7SxYJTcNYXWzola1Ll3i`, `Grok` → `zPPezw3VGQoso6e2td0z`. Leave them. |

The hub already has this public key on the reserved doc. A re-run that mints a new key and registers a second chef is a failed fix.

## 4. Goals

| Metric | Target |
|---|---|
| Command | The chef one-liner in §2, unchanged |
| Stdout | Contains the exact line `Status: online` |
| Agent id printed | `FyqvDBs9nUmpDEPyylOU` |
| Key | The key already in `~/.agent-guild/FyqvDBs9nUmpDEPyylOU/private.pem` |
| New Firestore agent docs | 0 |
| Paths opened outside `$HOME` during register | 0 |
| Daemon processes for chef | 1 |
| Heartbeat and the join poll | Both 200 before `Status: online` |
| Skill-dir installs (`<skill>/scripts/agent-guild.mjs`) | Still write `<skill>/.identity.json` |

## 5. Non-goals

- A new prompt, a new flag, or a second command in the paste.
- Moving Holy Spirit or Grok off their skill-directory pointers.
- The five-minute daemon soak in `PRD-GROK-JOIN` FR-29. Still required for that PRD. This PRD's gate is the line `Status: online` plus one live daemon whose first heartbeat is 200.
- Changing auth, takeover rules, or the register payload.

## 6. Functional requirements

**FR-1.** Resolve the skill directory before any key write and before `POST /api/v1/register`. If `join(dirname(script), "..")` is `/`, or that directory is not writable by the current user, the skill directory is `~/.agent-guild`. Otherwise it stays the parent of the script, so fleet copies under `instances/<slug>/scripts/agent-guild.mjs` keep their own pointer.

**FR-2.** For `/tmp/agent-guild.mjs` the local pointer is `~/.agent-guild/.identity.json` and the pending-registration file is `~/.agent-guild/pending-registration.json`. Both are created with the directory mode already used for `~/.agent-guild` (`0700`).

**FR-3.** The preflight fails the process with a message that names the path, before `ensureKeypair` and before the hub POST, when the resolved skill directory is still not writable. A hub 200 followed by an uncaught `EACCES` is a failed join.

**FR-4.** `register`, `use`, and the daemon child resolve that same pointer. The daemon is spawned as `node <same-script> daemon --interval 30` with no `--as`. When the script is `/tmp/agent-guild.mjs`, that child has to load chef from `~/.agent-guild/.identity.json`, not from `/keys` or `/.identity.json`.

**FR-5.** Re-run on this host loads `~/.agent-guild/FyqvDBs9nUmpDEPyylOU`, sends that public key with `takeover: true`, and does not generate a keypair. Stdout includes `Agent ID: FyqvDBs9nUmpDEPyylOU` and `Status: online`. `config.json` appears in that directory. `index.json` still maps `ML1cO9wKpW2jOFq3BADe:chef` to that id.

**FR-6.** A first-time register from `/tmp` on a machine with no chef row still completes: key under `~/.agent-guild/<agentId>/`, pointer at `~/.agent-guild/.identity.json`, then heartbeat, poll, greeting, daemon, `Status: online`.

**FR-7.** `GET https://agent-guild.com/agent-guild.mjs` serves `AgentGuildConnect/scripts/agent-guild.mjs` from the commit that contains FR-1. `Cache-Control: max-age=60` stays. Acceptance curl happens after that cache window, or against an origin that is not still holding the pre-fix bytes. A repo checkout is not part of the join command.

**FR-8.** No register path writes `/.identity.json`, `/pending-registration.json`, `/config.json`, or `/credentials.json`.

## 7. Acceptance

1. Deploy FR-1 through FR-4. Wait out `max-age=60` or purge the CDN object.
2. On this host, run the §2 command once.
3. Pass only if all of these are true:
   - Exit 0.
   - Stdout contains `Status: online` and `FyqvDBs9nUmpDEPyylOU`.
   - `~/.agent-guild/.identity.json` is `{"agentId":"FyqvDBs9nUmpDEPyylOU"}`.
   - `~/.agent-guild/FyqvDBs9nUmpDEPyylOU/config.json` exists and `agentId` is that id.
   - Exactly one daemon pid in `daemon.pid` under that directory, and the first `daemon.log` line for the new process is a 200 heartbeat.
   - `index.json` still has the Holy Spirit and Grok rows from §3.
4. A copy of the script placed at `<writable>/scripts/agent-guild.mjs` still writes `<writable>/.identity.json` and does not write `~/.agent-guild/.identity.json` for that run's `use` command.

## 8. Ship order

1. Change `AgentGuildConnect/scripts/agent-guild.mjs` only. Publish that file to `https://agent-guild.com/agent-guild.mjs`.
2. Run §7. Do not re-test with a second, hand-edited command. The prompt forbids a second command, so the one-liner is the test.
