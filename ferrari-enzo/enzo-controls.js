/**
 * enzo-controls.js  v1.0.0
 * Procedural controls for the Ferrari Enzo model exported by ferrari_enzo_v1_0_0_door_rig.py (Blender -> GLB).
 *
 *   import * as THREE from 'three';
 *   import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
 *   import { EnzoRig } from './enzo-controls.js';
 *
 *   const gltf = await new GLTFLoader().loadAsync('ferrari_enzo_converted_v1_0_0.glb');
 *   scene.add(gltf.scene);
 *   const rig = new EnzoRig(gltf.scene, { scene });      // scene = where the lamp lights are added
 *   rig.openDoors();  rig.setHeadlamps(true);            // ...call rig.update(dt) every frame
 *
 * What it reads from the GLB (names come from the Blender script):
 *   ENZO_DoorAssembly_L/R  -> ENZO_DoorSeal_L/R -> ENZO_DoorHinge_L/R -> door, glass, mirror
 *   ENZO_MirrorPivot_L/R   (only when the mirror pivots on its own base)
 *   ENZO_Headlamp_*, ENZO_Taillight_*   (meshes)
 *   ENZO_Root.userData.door_max_angle   (opening angle fitted in Blender; needs "Custom Properties" on export)
 * The door motion is the same curve as the Blender drivers: the door first pops 12 mm off its seals, then swings
 * about the hinge axis (the A-pillar line) with an ease in/out.
 */
import * as THREE from 'three';

export const ENZO_DEFAULTS = {
  crackFrac: 0.06,          // slider part used only for the seal pop (matches Blender DOOR_CRACK_FRAC)
  popFrac: 0.18,            // slider value where the seal pop is finished (DOOR_POP_FRAC)
  popMeters: 0.012,         // outward seal step in metres (DOOR_POP_OUT_M)
  maxAngleDeg: null,        // null = ENZO_Root.userData.door_max_angle, else this fallback (see fallbackAngleDeg)
  fallbackAngleDeg: 55,
  hingeAxis: 'y',           // Blender local Z becomes local Y in glTF
  lateralAxis: 'x',         // car width axis in the exported scene (Blender X stays X)
  doorSeconds: 2.2,         // time for a full open / close
  lightSeconds: 0.18,       // lamp fade time
  headColor: 0xfff1d2, tailColor: 0xff1a0e,
  headEmissive: 3.0, tailEmissive: 2.6,
  headLight: 140, tailLight: 1.2,      // SpotLight / PointLight intensity (candela, three r155+)
  enhanceMaterials: true,   // glass transparent, chrome metallic, body clear-coat (procedural Blender textures are not exported)
};

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => x * x * (3 - 2 * x);

export class EnzoRig {
  constructor(root, options = {}) {
    this.o = Object.assign({}, ENZO_DEFAULTS, options);
    this.root = root;
    this.scene = options.scene || null;
    this.carRoot = root.getObjectByName('ENZO_Root') || root;
    this.doors = {};            // side -> {asm, seal, hinge, pivots[], sealRest, sign, outDir, target, value}
    this.lights = { head: { on: false, v: 0, target: 0 }, tail: { on: false, v: 0, target: 0 } };
    this._lampMeshes = { head: [], tail: [] };
    this._spots = [];
    this._points = [];
    this.angleDeg = this._readAngle();
    this.carRoot.updateMatrixWorld(true);
    this.missing = [];
    for (const side of ['L', 'R']) this._initDoor(side);
    this._initLamps();
    if (this.o.enhanceMaterials) this.enhanceMaterials();
  }

  // ------------------------------------------------------------ doors
  _readAngle() {
    if (this.o.maxAngleDeg != null) return this.o.maxAngleDeg;
    const ud = this.carRoot.userData || {};
    const v = Number(ud.door_max_angle);
    return Number.isFinite(v) && v > 1 ? v : this.o.fallbackAngleDeg;
  }

  _initDoor(side) {
    const by = (n) => this.root.getObjectByName(n);
    const asm = by('ENZO_DoorAssembly_' + side), seal = by('ENZO_DoorSeal_' + side), hinge = by('ENZO_DoorHinge_' + side);
    if (!asm || !seal || !hinge) { this.missing.push('door rig ' + side); return; }
    const pivots = [];
    seal.children.forEach((c) => { if (c.name.startsWith('ENZO_MirrorPivot_' + side)) pivots.push(c); });
    const d = { asm, seal, hinge, pivots, sealRest: seal.position.clone(), target: 0, value: 0 };
    // which way is "outward": away from the car centre along the lateral axis
    const ax = this.o.lateralAxis;
    const carBox = new THREE.Box3().setFromObject(this.carRoot);
    const carC = carBox.getCenter(new THREE.Vector3());
    const doorC = new THREE.Box3().setFromObject(hinge).getCenter(new THREE.Vector3());
    const dir = Math.sign(doorC[ax] - carC[ax]) || (side === 'L' ? 1 : -1);
    d.outWorld = new THREE.Vector3(); d.outWorld[ax] = dir;
    // rotation sense that swings the door outward and up (the Blender driver sign is not stored in the GLB)
    d.sign = this.o.doorSign && this.o.doorSign[side] != null ? this.o.doorSign[side] : this._detectSign(d, doorC, ax, dir);
    this.doors[side] = d;
    this._applyDoor(d, 0);
  }

  _detectSign(d, c0, ax, dir) {
    const probe = THREE.MathUtils ? THREE.MathUtils.degToRad(35) : 35 * Math.PI / 180;
    let best = null;
    for (const sg of [1, -1]) {
      d.hinge.rotation[this.o.hingeAxis] = sg * probe;
      this.carRoot.updateMatrixWorld(true);
      const c = new THREE.Box3().setFromObject(d.hinge).getCenter(new THREE.Vector3());
      const score = (c[ax] - c0[ax]) * dir + 0.5 * (c.y - c0.y);
      if (!best || score > best.score) best = { score, sg };
    }
    d.hinge.rotation[this.o.hingeAxis] = 0;
    this.carRoot.updateMatrixWorld(true);
    return best.sg;
  }

  /** v = slider 0..1 (same meaning as door_L_open / door_R_open in Blender). */
  _applyDoor(d, v) {
    const o = this.o;
    const popT = smooth(clamp01(v / o.popFrac));
    const rotT = smooth(clamp01((v - o.crackFrac) / (1 - o.crackFrac)));
    // seal pop: outward in world space -> the assembly's local frame
    const q = d.asm.getWorldQuaternion(new THREE.Quaternion()).invert();
    const s = d.asm.getWorldScale(new THREE.Vector3());
    const local = d.outWorld.clone().applyQuaternion(q).multiplyScalar((o.popMeters * popT) / (s.x || 1));
    d.seal.position.copy(d.sealRest).add(local);
    const ang = d.sign * (this.angleDeg * Math.PI / 180) * rotT;
    d.hinge.rotation[o.hingeAxis] = ang;
    for (const p of d.pivots) p.rotation[o.hingeAxis] = ang;
    d.value = v;
  }

  setDoor(side, value, animate = true) {           // side: 'L' | 'R' | 'both'
    const sides = side === 'both' ? ['L', 'R'] : [side];
    for (const sd of sides) {
      const d = this.doors[sd];
      if (!d) continue;
      d.target = clamp01(value);
      if (!animate) this._applyDoor(d, d.target);
    }
  }
  openDoors() { this.setDoor('both', 1); }
  closeDoors() { this.setDoor('both', 0); }
  toggleDoors() { const open = Object.values(this.doors).some((d) => d.target > 0.5); this.setDoor('both', open ? 0 : 1); }
  /** Opening angle in degrees (Blender: door_max_angle). */
  setAngle(deg) { this.angleDeg = deg; for (const d of Object.values(this.doors)) this._applyDoor(d, d.value); }

  // ------------------------------------------------------------ lights
  _initLamps() {
    const heads = [], tails = [];
    this.root.traverse((n) => {
      if (!n.isMesh) return;
      if (/headlamp|headlight/i.test(n.name)) heads.push(n);
      else if (/taillight|tail_light|taillamp/i.test(n.name)) tails.push(n);
    });
    const prep = (list, kind) => list.forEach((m) => {
      m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : m.material.clone();   // do not touch shared materials
      this._lampMeshes[kind].push(m);
    });
    prep(heads, 'head'); prep(tails, 'tail');
    if (!heads.length) this.missing.push('headlamp meshes');
    if (!tails.length) this.missing.push('taillight meshes');
    this.carRoot.updateMatrixWorld(true);
    const centre = (list) => {
      const b = new THREE.Box3();
      list.forEach((m) => b.expandByObject(m));
      return b.getCenter(new THREE.Vector3());
    };
    const fwd = new THREE.Vector3();
    if (heads.length && tails.length) {
      fwd.copy(centre(heads)).sub(centre(tails)); fwd.y = 0; fwd.normalize();      // nose = from tail lamps toward headlamps
    } else fwd.set(0, 0, 1);
    this._fwd = fwd;
    const host = this.scene || this.root;
    heads.forEach((m) => {
      const c = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
      const sp = new THREE.SpotLight(this.o.headColor, 0, 45, 0.5, 0.6, 2);
      sp.position.copy(c);
      sp.target.position.copy(c).add(fwd.clone().multiplyScalar(8)).add(new THREE.Vector3(0, -0.6, 0));
      host.add(sp); host.add(sp.target);
      this._spots.push(sp);
    });
    tails.forEach((m) => {
      const c = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
      const pl = new THREE.PointLight(this.o.tailColor, 0, 2.5, 2);
      pl.position.copy(c).sub(fwd.clone().multiplyScalar(0.12));
      host.add(pl);
      this._points.push(pl);
    });
    this._applyLamps();
  }

  _applyLamps() {
    const o = this.o;
    for (const kind of ['head', 'tail']) {
      const v = this.lights[kind].v;
      const color = kind === 'head' ? o.headColor : o.tailColor;
      const peak = kind === 'head' ? o.headEmissive : o.tailEmissive;
      for (const m of this._lampMeshes[kind]) {
        for (const mat of (Array.isArray(m.material) ? m.material : [m.material])) {
          if (!mat.emissive) continue;
          mat.emissive.setHex(color);
          mat.emissiveIntensity = peak * v;
          mat.needsUpdate = false;
        }
      }
    }
    this._spots.forEach((s) => { s.intensity = this.o.headLight * this.lights.head.v; });
    this._points.forEach((p) => { p.intensity = this.o.tailLight * this.lights.tail.v; });
  }

  setHeadlamps(on) { this.lights.head.on = !!on; this.lights.head.target = on ? 1 : 0; }
  setTaillights(on) { this.lights.tail.on = !!on; this.lights.tail.target = on ? 1 : 0; }
  setLights(on) { this.setHeadlamps(on); this.setTaillights(on); }
  toggleLights() { this.setLights(!(this.lights.head.on || this.lights.tail.on)); }

  // ------------------------------------------------------------ look
  /** Procedural Blender textures are not exported to glTF; give the main materials a sensible look. */
  enhanceMaterials() {
    const seen = new Set();
    this.root.traverse((n) => {
      if (!n.isMesh) return;
      for (const mat of (Array.isArray(n.material) ? n.material : [n.material])) {
        if (!mat || seen.has(mat)) continue;
        seen.add(mat);
        const name = mat.name || '';
        if (/glass/i.test(name)) { mat.transparent = true; mat.opacity = 0.35; mat.roughness = 0.05; mat.metalness = 0.0; mat.depthWrite = false; }
        else if (/chrome/i.test(name)) { mat.metalness = 1; mat.roughness = 0.12; }
        else if (/tyre|tire/i.test(name)) { mat.metalness = 0; mat.roughness = 0.9; }
        else if (/body/i.test(name)) { mat.metalness = 0.55; mat.roughness = 0.28; if ('clearcoat' in mat) { mat.clearcoat = 1; mat.clearcoatRoughness = 0.06; } }
      }
    });
  }
  /** Re-paint every body material, e.g. rig.setPaint('#c40000'). */
  setPaint(color) {
    // The exported Enzo GLB names its main red body material
    // "ENZO_MAT_RossoCorsa" (not "body"). Keep the generic body-name
    // fallback for other model exports that use this rig.
    const paintMaterialPattern = /rossocorsa|body/i;
    const seen = new Set();
    let updated = 0;

    this.root.traverse((n) => {
      if (!n.isMesh) return;

      const materials = Array.isArray(n.material) ? n.material : [n.material];
      for (const mat of materials) {
        if (!mat || seen.has(mat) || !paintMaterialPattern.test(mat.name || '')) continue;

        seen.add(mat);
        if (mat.color) mat.color.set(color);
        // The Enzo body paint is a material colour, not an image texture.
        // Preserve any future texture maps rather than silently removing them.
        mat.needsUpdate = true;
        updated++;
      }
    });

    if (updated === 0) {
      console.warn('[EnzoRig] No paint material found. Expected ENZO_MAT_RossoCorsa or a material containing "body".');
    }
    return updated;
  }

  // ------------------------------------------------------------ per-frame
  update(dt) {
    const step = dt / this.o.doorSeconds;
    for (const d of Object.values(this.doors)) {
      if (d.value === d.target) continue;
      const nv = d.value < d.target ? Math.min(d.target, d.value + step) : Math.max(d.target, d.value - step);
      this._applyDoor(d, nv);
    }
    const ls = dt / this.o.lightSeconds;
    let dirty = false;
    for (const k of ['head', 'tail']) {
      const l = this.lights[k];
      if (l.v !== l.target) { l.v = l.v < l.target ? Math.min(l.target, l.v + ls) : Math.max(l.target, l.v - ls); dirty = true; }
    }
    if (dirty) this._applyLamps();
  }

  get doorsOpen() { return Object.values(this.doors).map((d) => +d.value.toFixed(3)); }
  get info() {
    return { angleDeg: this.angleDeg, doors: Object.keys(this.doors), signs: Object.fromEntries(Object.entries(this.doors).map(([k, d]) => [k, d.sign])), missing: this.missing };
  }
}
