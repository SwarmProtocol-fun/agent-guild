import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

/**
 * AiAvatar — visual + physics container for a single agent.
 *
 * In dimos mode the agent's pose is driven externally over LCM (cmd_vel in →
 * server physics → /odom out, then engine.js calls `setPosition`).  This
 * class therefore only owns:
 *   - the THREE.Group visual (fallback capsule + facing cone + optional GLB)
 *   - the Rapier rigid body + capsule colliders
 *   - GLB load with auto-scale and box-collider resize
 *   - setPosition / getPosition for external drive
 *   - per-frame `update` that ticks the animation mixer and syncs the visual
 *
 * The autonomous wander / VLM behavior that lived here previously is gone —
 * dimos drives the agent, and engine.js even overrides `update` on the dimos
 * agent to skip everything except the visual sync.
 */
export class AiAvatar {
  constructor({
    id = null,
    scene,
    rapierWorld,
    RAPIER,
    avatarUrl = "/avatars/kai.glb",
    headless = false,
    radius = 0.12,
    halfHeight = 0.25,
  }) {
    this.id = id || `ai-${Math.random().toString(36).slice(2, 8)}`;
    this.scene = scene;
    this.rapierWorld = rapierWorld;
    this.RAPIER = RAPIER;
    this.avatarUrl = avatarUrl;
    this.headless = headless;

    // Capsule dims from the embodiment, so the avatar's feet sit on the capsule
    // bottom (default to the small player capsule when none is given).
    this.radius = radius ?? 0.12;
    this.halfHeight = halfHeight ?? 0.25;

    // Look pitch — engine.js reads this when capturing the agent's POV.
    this.pitch = 0;

    this.group = new THREE.Group();
    this.group.name = `AiAvatar:${this.id}`;
    this.scene.add(this.group);

    // Fallback capsule visual.  Replaced by the GLB once loaded.
    this.fallback = new THREE.Mesh(
      new THREE.CapsuleGeometry(this.radius * 0.9, this.halfHeight * 2.0, 6, 10),
      new THREE.MeshStandardMaterial({ color: 0x8cffc1, roughness: 0.65 }),
    );
    this.fallback.castShadow = false;
    this.fallback.receiveShadow = false;
    this.group.add(this.fallback);

    // Direction indicator (visible until GLB hides it in _applyGLB).
    this._facing = new THREE.Mesh(
      new THREE.ConeGeometry(this.radius * 0.45, this.radius * 1.35, 14),
      new THREE.MeshStandardMaterial({ color: 0xffc36a, roughness: 0.45, metalness: 0.05 }),
    );
    this._facing.rotation.x = Math.PI / 2;
    this._facing.position.set(0, this.halfHeight * 0.15, this.radius * 1.1);
    this._facing.renderOrder = 10;
    this.group.add(this._facing);

    // Rapier body + capsule collider (kinematic — pose is set, not simulated).
    this.body = this.rapierWorld.createRigidBody(
      this.RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 3, 0),
    );
    this.collider = this.rapierWorld.createCollider(
      this.RAPIER.ColliderDesc.capsule(this.halfHeight, this.radius).setFriction(0.8),
      this.body,
    );

    // Horizontal "spine" capsule trailing behind the vertical capsule so the
    // physics body roughly matches a quadruped silhouette.  Used by lidar and
    // collision; movement controller still uses the vertical capsule.
    this._spineHalfLen = Math.max(this.radius * 1.2, 0.13);
    this._spineRadius = Math.max(this.radius * 0.62, 0.07);
    this._spineOffsetBack = Math.max(
      this.radius * 2.2,
      this._spineHalfLen + this._spineRadius + 0.02,
    );
    this._spineOffsetY = Math.max(this.halfHeight * 0.35, 0.08);
    this.spineCollider = this.rapierWorld.createCollider(
      this.RAPIER.ColliderDesc.capsule(this._spineHalfLen, this._spineRadius)
        .setFriction(0.8)
        .setTranslation(0, this._spineOffsetY, -this._spineOffsetBack)
        // Rotate the capsule's local +Y axis to +Z (along the spine).
        .setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }),
      this.body,
    );
    this.boxCollider = null; // Replaced when GLB loads (matches model bbox).

    // Best-effort: load the requested GLB.  Falls through avatarUrl array if a
    // load fails, ultimately leaving the capsule fallback in place.
    this._loadGLB();
  }

  dispose() {
    try { this.scene.remove(this.group); } catch { /* already gone */ }
    try {
      if (this.boxCollider) this.rapierWorld.removeCollider(this.boxCollider, true);
      if (this.spineCollider) this.rapierWorld.removeCollider(this.spineCollider, true);
      this.rapierWorld.removeCollider(this.collider, true);
      this.rapierWorld.removeRigidBody(this.body);
    } catch { /* world torn down already */ }
  }

  setPosition(x, y, z) {
    this.body.setTranslation({ x, y, z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  }

  getPosition() {
    const p = this.body.translation();
    return [p.x, p.y, p.z];
  }

  update(dt) {
    if (this.mixer) this.mixer.update(dt);
    this._syncVisual();
    this._animateGait(dt);
  }

  _syncVisual() {
    if (!this.body) return;
    const p = this.body.translation();
    this.group.position.set(p.x, p.y, p.z);
    this._syncSpineCollider();
  }

  /**
   * Agent Guild embed: glide the visual toward the body pose instead of snapping.
   * The embed's act() moves the body up to 2 m and turns up to 180° in one call,
   * so snapping reads as teleporting. The visual follows the body's poses in
   * order (so a move that lands mid-glide doesn't cut a corner through the
   * furniture), turning first and then walking, like the action, at roughly
   * walking pace (a 2 m move takes ~1.7 s).
   * Only the visual lags; the body (physics, captures, scoring) stays exact.
   */
  easeVisual(dt, yaw) {
    if (!this.body) return;
    const p = this.body.translation();
    const g = this.group.position;
    const path = (this._path ??= []);
    const tail = path.at(-1) ?? { x: g.x, z: g.z, yaw: this.group.rotation.y };
    const jump = Math.hypot(p.x - tail.x, p.z - tail.z);
    if (jump > 3) {
      // A teleport (reset) — don't animate it.
      this.snapVisual(yaw);
      return;
    }
    if (jump > 0.02 || Math.abs(Math.atan2(Math.sin(yaw - tail.yaw), Math.cos(yaw - tail.yaw))) > 0.03) {
      path.push({ x: p.x, z: p.z, yaw });
    }
    // Total distance still to walk, for catching up when far behind.
    let behind = 0;
    for (let k = 0, from = g; k < path.length; from = path[k++]) behind += Math.hypot(path[k].x - from.x, path[k].z - from.z);

    let step = Math.min(dt, 0.1);
    while (path.length && step > 1e-6) {
      const wp = path[0];
      // Walking pace, so a move fills the time the agent spends choosing the
      // next one instead of zipping there and standing still. It still speeds
      // up when far behind, and outpaces keyboard driving (1 m/s, 90°/s).
      let dyaw = Math.atan2(Math.sin(wp.yaw - this.group.rotation.y), Math.cos(wp.yaw - this.group.rotation.y));
      const turnRate = Math.max(2.2, Math.abs(dyaw) * 1.2);
      const turn = Math.min(Math.abs(dyaw), turnRate * step);
      this.group.rotation.y += Math.sign(dyaw) * turn;
      dyaw -= Math.sign(dyaw) * turn;
      step -= turn / turnRate;
      if (Math.abs(dyaw) > 0.05) break;
      const dx = wp.x - g.x, dz = wp.z - g.z;
      const dist = Math.hypot(dx, dz);
      const moveRate = Math.max(1.1, behind * 0.9);
      const move = Math.min(dist, moveRate * step);
      if (dist > 1e-6) g.set(g.x + (dx * move) / dist, p.y, g.z + (dz * move) / dist);
      step -= move / moveRate;
      if (dist - move < 1e-4 && Math.abs(dyaw) < 0.01) {
        g.set(wp.x, p.y, wp.z);
        this.group.rotation.y = wp.yaw;
        path.shift();
      } else break;
    }
    if (!path.length) g.y = p.y;
    if (this.mixer) this.mixer.update(dt);
    this._syncSpineCollider();
    this._animateGait(dt);
  }

  /** Put the visual on the body now (a reset or teleport), dropping any pending glide. */
  snapVisual(yaw) {
    this._path = [];
    this._syncVisual();
    this.group.rotation.y = yaw;
    if (this._gait) this._gait.last = null;
  }

  /**
   * The Go2 GLB has no animation clips, but its legs are separate parts placed
   * at their joints (a flat list: FL_thigh, FL_calf, FL_foot, … in the body
   * frame, x forward, y up, legs straight down at rest). Find them so
   * _animateGait can pose a trot.
   */
  _setupGait() {
    this._legs = [];
    const find = (leg, part) => {
      let hit = null;
      this.model.traverse((o) => {
        if (!hit && new RegExp(`^${leg}_${part}_\\d+$`).test(o.name)) hit = o;
      });
      return hit;
    };
    for (const [leg, phase] of [["FL", 0], ["RR", 0], ["FR", Math.PI], ["RL", Math.PI]]) {
      const thigh = find(leg, "thigh"), calf = find(leg, "calf"), foot = find(leg, "foot");
      if (!thigh || !calf || !foot) continue;
      this._legs.push({
        phase,
        thigh, calf, foot,
        thighGuard: find(leg, "thigh_protector"),
        hip: thigh.position.clone(),
        upper: thigh.position.distanceTo(calf.position),
        lower: calf.position.distanceTo(foot.position),
      });
    }
    this._gait = { phase: 0, amp: 0, last: null };
  }

  /**
   * Procedural trot: diagonal leg pairs swing in antiphase, knees bend to lift
   * each foot on its forward swing. Driven by how fast the visual is moving or
   * turning, so it fades to standing when the robot stops.
   */
  _animateGait(dt) {
    if (!this._legs?.length || !(dt > 0)) return;
    const g = this._gait;
    const pos = this.group.position, yaw = this.group.rotation.y;
    let speed = 0;
    if (g.last) {
      const turn = Math.abs(Math.atan2(Math.sin(yaw - g.last.yaw), Math.cos(yaw - g.last.yaw)));
      // A turn in place steps too; ~0.25 m/s-equivalent per rad/s.
      speed = (Math.hypot(pos.x - g.last.x, pos.z - g.last.z) + turn * 0.25) / dt;
    }
    g.last = { x: pos.x, z: pos.z, yaw };
    if (speed > 5) speed = 0; // a teleport, not a walk
    const target = Math.min(1, speed / 0.6);
    g.amp += (target - g.amp) * Math.min(1, dt * 8);
    g.phase += dt * Math.PI * 2 * (1.6 + 1.4 * Math.min(1, speed / 1.2)); // ~1.6–3 strides/s

    for (const leg of this._legs) {
      const p = g.phase + leg.phase;
      const swing = g.amp * 0.32 * Math.sin(p);
      // Foot moves forward while cos(p) > 0: bend the knee then to lift it.
      const lift = g.amp * 0.32 * Math.max(0, Math.cos(p));
      const a = swing - lift, b = 2 * lift;
      leg.thigh.rotation.z = a;
      if (leg.thighGuard) leg.thighGuard.rotation.z = a;
      leg.calf.position.set(leg.hip.x + leg.upper * Math.sin(a), leg.hip.y - leg.upper * Math.cos(a), leg.hip.z);
      leg.calf.rotation.z = a + b;
      leg.foot.position.set(leg.calf.position.x + leg.lower * Math.sin(a + b), leg.calf.position.y - leg.lower * Math.cos(a + b), leg.hip.z);
      leg.foot.rotation.z = a + b;
    }
  }

  _syncSpineCollider() {
    if (!this.spineCollider || !this.body) return;
    const p = this.body.translation();
    const yaw = this.group.rotation.y ?? 0;
    const xOff = -Math.sin(yaw) * this._spineOffsetBack;
    const zOff = -Math.cos(yaw) * this._spineOffsetBack;
    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(Math.PI / 2, yaw, 0, "YXZ"),
    );
    try {
      if (typeof this.spineCollider.setTranslationWrtParent === "function") {
        this.spineCollider.setTranslationWrtParent({ x: xOff, y: this._spineOffsetY, z: zOff });
      } else {
        this.spineCollider.setTranslation({
          x: p.x + xOff, y: p.y + this._spineOffsetY, z: p.z + zOff,
        });
      }
      if (typeof this.spineCollider.setRotationWrtParent === "function") {
        this.spineCollider.setRotationWrtParent({ x: q.x, y: q.y, z: q.z, w: q.w });
      } else {
        this.spineCollider.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
      }
    } catch { /* collider torn down */ }
  }

  _loadGLB() {
    if (!this.avatarUrl) return;
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const urls = Array.isArray(this.avatarUrl) ? this.avatarUrl : [this.avatarUrl];
    const tryLoad = (index) => {
      if (index >= urls.length) {
        console.log(`[AiAvatar] No avatar model found, using capsule fallback.`);
        return;
      }
      loader.load(
        urls[index],
        (gltf) => { this._applyGLB(gltf); },
        undefined,
        // Surface avatar-load failures — silent fallback to a bare capsule is a
        // confusing footgun (usually a stale Git-LFS pointer in dist/).
        (err) => { console.warn(`[AiAvatar] avatar GLB load failed: ${urls[index]} -> ${err?.message || err}`); tryLoad(index + 1); },
      );
    };
    tryLoad(0);
  }

  _applyGLB(gltf) {
    try { this.group.remove(this.fallback); } catch { /* already gone */ }
    try { this._facing.visible = false; } catch { /* gone */ }

    this.model = gltf.scene;

    // Auto-fit: scale the model to roughly the capsule height, then offset down
    // so its feet are on the floor (group origin sits at body center).
    const bbox = new THREE.Box3().setFromObject(this.model);
    const size = bbox.getSize(new THREE.Vector3());
    const targetHeight = this.halfHeight * 2 + this.radius * 2;
    const scaleFactor = targetHeight / (size.y || 1);
    // Y-squash so the unrigged GLB reads as a low-slung quadruped instead of an
    // upright biped.  Camera POV (GO2_CAMERA_HEIGHT in engine.js) is the real
    // signal; this is purely visual.
    this.model.scale.set(scaleFactor, scaleFactor * 0.6, scaleFactor);

    bbox.setFromObject(this.model);
    const newCenter = bbox.getCenter(new THREE.Vector3());
    const newMin = bbox.min;
    this.model.position.x -= newCenter.x;
    this.model.position.z -= newCenter.z;
    this.model.position.y = -newMin.y - (this.halfHeight + this.radius);

    // Replace the placeholder box collider with one that matches the GLB bbox.
    bbox.setFromObject(this.model);
    const finalSize = bbox.getSize(new THREE.Vector3());
    const finalCenter = bbox.getCenter(new THREE.Vector3());
    if (this.boxCollider) {
      this.rapierWorld.removeCollider(this.boxCollider, true);
      this.boxCollider = null;
    }
    this.boxCollider = this.rapierWorld.createCollider(
      this.RAPIER.ColliderDesc
        .cuboid(finalSize.x / 2, finalSize.y / 2, finalSize.z / 2)
        .setFriction(0.8)
        .setTranslation(finalCenter.x, finalCenter.y, finalCenter.z),
      this.body,
    );

    // Headless: keep the collider, drop the visual — saves GPU memory.  Used
    // by dimos when no embodiment is requested (the agent moves invisibly).
    if (this.headless) {
      this.model = null;
      return;
    }

    this.model.traverse((m) => {
      if (m.isMesh) {
        m.castShadow = false;
        m.receiveShadow = true;
      }
    });
    this.group.add(this.model);
    this._setupGait();

    if (gltf.animations?.length) {
      this.mixer = new THREE.AnimationMixer(this.model);
      const actions = {};
      for (const clip of gltf.animations) {
        actions[clip.name] = this.mixer.clipAction(clip);
      }
      const idle = actions["idle"] || actions["Idle"] || actions["Idle_A"];
      if (idle) idle.play();
      else this.mixer.clipAction(gltf.animations[0]).play();
    }
  }
}
