import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export type Ray = { origin: number[]; target: number[]; hit: number[] | null; firstHit: string | null; visible: boolean };
export type Stage = { index: number; label: string; url: string; objects: string[] };
export interface ViewportModel {
  key: string; which: "baseline" | "candidate"; stages: Stage[]; finalUrl?: string; ray?: Ray;
  /** Additional native rays (e.g. one per inspection camera); drawn like `ray`. */
  rays?: Ray[];
  render?: { sample: number; samples: number }; running: boolean; title: string;
  /** Blender scenes are authored in metres; CAD parts in millimetres (shown at 1:20 in the viewport). */
  units?: "m" | "mm";
}
type View = "persp" | "top" | "front" | "right" | "camera";
const VIEWS: { id: View; label: string; key: string }[] = [
  { id: "persp", label: "透视", key: "5" }, { id: "top", label: "顶视", key: "7" }, { id: "front", label: "前视", key: "1" },
  { id: "right", label: "右视", key: "3" }, { id: "camera", label: "检查相机", key: "0" },
];
const vec = (v: number[]) => new THREE.Vector3(v[0], v[1], v[2]);
/** GLTFLoader sanitizes node names; the original Blender object name is kept in userData. */
const nativeName = (o: THREE.Object3D) => String(o.userData.name ?? o.parent?.userData.name ?? o.name ?? "object");
function webglAvailable() {
  try { const c = document.createElement("canvas"); return Boolean(c.getContext("webgl2") ?? c.getContext("webgl")); } catch { return false; }
}

interface Runtime {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls;
  root: THREE.Group; overlay: THREE.Group; grid: THREE.GridHelper; axes: THREE.AxesHelper; frame: number;
  animations: { start: number; duration: number; apply: (t: number) => void }[]; loader: GLTFLoader; known: Set<string>;
  /** Render on demand: only when the camera moves, an animation runs or the scene changed. */
  dirty: boolean;
  /** Framing of the current model: large native scenes (factory halls) are framed instead of the 12 m workcell default. */
  fit: { center: THREE.Vector3; scale: number; key?: string };
  mixer?: THREE.AnimationMixer; playing: boolean; last: number;
}

/** Professional viewport over native Blender GLB snapshots. Presentation only; evidence stays in digests. */
export default function Viewport({ model }: { model?: ViewportModel }) {
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime>(undefined);
  const [webgl, setWebgl] = useState<"pending" | "ok" | "unavailable">("pending");
  const [objects, setObjects] = useState<{ name: string; visible: boolean; size: [number, number, number] }[]>([]);
  const [selected, setSelected] = useState<string>();
  const [scrub, setScrub] = useState<number>();
  const [view, setView] = useState<View>("persp");
  const [wire, setWire] = useState(false);
  const [xray, setXray] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showRay, setShowRay] = useState(true);
  const [loaded, setLoaded] = useState("");
  const [clips, setClips] = useState(0);
  // Focus mode (as in Onshape/Fusion/Sketchfab): the viewport fills the window; Esc or the same button restores.
  // The outliner is a panel that can be hidden; it starts hidden where the work area is narrow.
  const [maximized, setMaximized] = useState(false);
  const [panel, setPanel] = useState(() => typeof matchMedia === "function" ? matchMedia("(min-width: 1100px)").matches : true);
  const rootRef = useRef<HTMLDivElement>(null), maxButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!maximized) return;
    document.body.classList.add("viewport-focus");
    rootRef.current?.querySelector<HTMLCanvasElement>("canvas")?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setMaximized(false); } };
    addEventListener("keydown", esc);
    return () => { removeEventListener("keydown", esc); document.body.classList.remove("viewport-focus"); maxButton.current?.focus(); };
  }, [maximized]);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    if (!webglAvailable()) { setWebgl("unavailable"); return; }
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.setAttribute("aria-label", "三维视口：拖动旋转，滚轮缩放，右键平移");
    renderer.domElement.tabIndex = 0;
    element.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1a20);
    scene.fog = new THREE.Fog(0x0d1a20, 14, 32);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 200);
    camera.position.set(6.5, 5.2, 7.5);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.target.set(0, 0.6, 0);
    controls.addEventListener("change", () => { if (runtime.current) runtime.current.dirty = true; });
    scene.add(new THREE.HemisphereLight(0xdcefff, 0x1b2a2e, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(4, 8, 5); key.castShadow = true; key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004; key.shadow.normalBias = 0.03;
    Object.assign(key.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6 });
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x6fe3c1, 0.8); rim.position.set(-6, 3, -4); scene.add(rim);
    const grid = new THREE.GridHelper(12, 24, 0x3f6f68, 0x1f3a3c);
    (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.55;
    scene.add(grid);
    const axes = new THREE.AxesHelper(0.6); axes.position.set(-2.4, 0.01, 1.9); scene.add(axes);
    const root = new THREE.Group(), overlay = new THREE.Group();
    scene.add(root, overlay);
    const r: Runtime = { renderer, scene, camera, controls, root, overlay, grid, axes, frame: 0, animations: [], loader: new GLTFLoader(), known: new Set(), dirty: true,
      fit: { center: new THREE.Vector3(0, 0.6, 0), scale: 1 }, playing: false, last: 0 };
    runtime.current = r;
    const resize = () => {
      const w = element.clientWidth, h = element.clientHeight;
      renderer.setSize(w, h, false); camera.aspect = w / Math.max(h, 1); camera.updateProjectionMatrix(); r.dirty = true;
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    const tick = (now: number) => {
      r.frame = requestAnimationFrame(tick);
      const animating = r.animations.length > 0;
      r.animations = r.animations.filter(a => { const t = Math.min(1, (now - a.start) / a.duration); a.apply(t); return t < 1; });
      const moved = controls.update();
      const dt = r.last ? Math.min(0.1, (now - r.last) / 1000) : 0; r.last = now;
      if (r.mixer && r.playing) { r.mixer.update(dt); r.dirty = true; }
      if (animating || moved || r.dirty) { renderer.render(scene, camera); r.dirty = false; }
    };
    r.frame = requestAnimationFrame(tick);
    setWebgl("ok");
    return () => {
      cancelAnimationFrame(r.frame); observer.disconnect(); controls.dispose(); renderer.dispose();
      renderer.domElement.remove(); runtime.current = undefined;
    };
  }, []);

  const stages = model?.stages ?? [];
  const activeIndex = scrub !== undefined && scrub < stages.length ? scrub : undefined;
  const url = activeIndex !== undefined ? stages[activeIndex].url : model?.finalUrl ?? stages.at(-1)?.url;
  useEffect(() => { setScrub(undefined); runtime.current?.known.clear(); }, [model?.key, model?.which]);

  const scale = model?.units === "mm" ? 0.05 : 1, unit = model?.units ?? "m";
  useEffect(() => {
    const r = runtime.current;
    if (!r) return;
    if (!url) { r.root.clear(); r.known.clear(); r.dirty = true; setObjects([]); setSelected(undefined); setLoaded(""); return; }
    let cancelled = false;
    r.loader.load(url, gltf => {
      if (cancelled) return;
      r.root.clear();
      r.mixer?.stopAllAction(); r.mixer = undefined;
      gltf.scene.scale.setScalar(scale);
      gltf.scene.updateMatrixWorld(true);
      const meshes: THREE.Mesh[] = [];
      gltf.scene.traverse(o => { if ((o as THREE.Mesh).isMesh) { const m = o as THREE.Mesh; m.castShadow = true; m.receiveShadow = true; meshes.push(m); } });
      r.root.add(gltf.scene);
      const now = performance.now();
      // A native object may be exported as several meshes (OCCT writes one per B-Rep face): group by name.
      const fresh = new Set(meshes.map(nativeName).filter(n => !r.known.has(n)));
      const boxes = new Map<string, THREE.Box3>();
      meshes.forEach(m => {
        const name = nativeName(m);
        const box = new THREE.Box3().setFromObject(m);
        boxes.set(name, boxes.has(name) ? boxes.get(name)!.union(box) : box);
        if (fresh.has(name)) {
          // Newly produced native geometry grows in with a short glow: the "live build" effect.
          const material = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
          const scale = m.scale.clone(), glow = material.emissive?.clone();
          m.scale.setScalar(0.001);
          r.animations.push({ start: now, duration: 650, apply: t => {
            const e = 1 - Math.pow(1 - t, 3);
            m.scale.set(scale.x * e, scale.y * e, scale.z * e);
            if (material.emissive && glow) material.emissive.setRGB(glow.r + (1 - t) * 0.25, glow.g + (1 - t) * 0.55, glow.b + (1 - t) * 0.45);
          } });
        }
      });
      fresh.forEach(n => r.known.add(n));
      // Native animation (AGVs, robots, crane): presentation of the recipe's illustrative keyframes.
      if (gltf.animations.length) {
        r.mixer = new THREE.AnimationMixer(gltf.scene);
        for (const clip of gltf.animations) r.mixer.clipAction(clip).play();
        r.mixer.update(0);
      }
      setClips(gltf.animations.length);
      // Frame large scenes once per model: camera distance, fog and grid follow the native extent.
      // Union of the per-object boxes measured before the grow-in animation shrinks fresh meshes.
      const all = [...boxes.values()].reduce((u, b) => u.union(b), new THREE.Box3()), size = all.getSize(new THREE.Vector3());
      const fitKey = `${model?.key}:${model?.which}`;
      if (Math.max(size.x, size.z) <= 12 && r.fit.scale !== 1) {
        r.fit = { center: new THREE.Vector3(0, 0.6, 0), scale: 1 }; r.controls.maxPolarAngle = Math.PI; r.controls.maxDistance = Infinity;
        r.scene.fog = new THREE.Fog(0x0d1a20, 14, 32); r.grid.scale.setScalar(1); r.grid.position.set(0, 0, 0);
      }
      if (Math.max(size.x, size.z) > 12 && r.fit.key !== fitKey) {
        const scaleFit = Math.max(size.x, size.z) / 11, center = all.getCenter(new THREE.Vector3()).setY(0.6 * scaleFit);
        r.fit = { center, scale: scaleFit, key: fitKey };
        r.camera.position.copy(center).add(new THREE.Vector3(6.5, 5.2, 7.5).multiplyScalar(scaleFit * 0.62));
        r.controls.target.copy(center); r.camera.far = 200 * scaleFit; r.camera.updateProjectionMatrix();
        r.scene.fog = new THREE.Fog(0x0d1a20, 14 * scaleFit, 40 * scaleFit);
        r.grid.scale.setScalar(scaleFit * 1.2); r.grid.position.set(center.x, 0, center.z);
        const key = r.scene.children.find(o => (o as THREE.DirectionalLight).isDirectionalLight && (o as THREE.DirectionalLight).castShadow) as THREE.DirectionalLight | undefined;
        // Keep the orbit above the floor and outside the hall: halls are viewed like a site model.
        r.controls.maxPolarAngle = Math.PI * 0.46; r.controls.maxDistance = 30 * scaleFit;
        if (key) { Object.assign(key.shadow.camera, { left: -6 * scaleFit, right: 6 * scaleFit, top: 6 * scaleFit, bottom: -6 * scaleFit }); key.position.set(4 * scaleFit, 8 * scaleFit, 5 * scaleFit); key.shadow.camera.far = 40 * scaleFit; key.shadow.camera.updateProjectionMatrix(); }
      }
      const list = [...boxes].map(([name, box]) => { const size = box.getSize(new THREE.Vector3()).divideScalar(scale);
        return { name, visible: true, size: [size.x, size.y, size.z] as [number, number, number] }; });
      r.dirty = true; setObjects(list); setLoaded(url);
    }, undefined, () => { if (!cancelled) setLoaded(`error:${url}`); });
    return () => { cancelled = true; };
  }, [url, scale]);
  useEffect(() => { if (runtime.current) runtime.current.playing = playing; }, [playing]);
  useEffect(() => { if (!clips) setPlaying(false); }, [clips]);

  useEffect(() => {
    const r = runtime.current;
    if (!r) return;
    r.root.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const name = nativeName(m);
      const item = objects.find(x => x.name === name);
      m.visible = item?.visible ?? true;
      for (const material of Array.isArray(m.material) ? m.material : [m.material]) {
        const standard = material as THREE.MeshStandardMaterial;
        standard.wireframe = wire;
        // Respect authored transparency (e.g. guard mesh panels); X-ray only makes things more transparent.
        if (standard.userData.baseOpacity === undefined) standard.userData.baseOpacity = standard.opacity;
        const base = Number(standard.userData.baseOpacity);
        standard.opacity = xray ? Math.min(0.32, base) : base; standard.transparent = xray || base < 1; standard.depthWrite = !(xray || base < 1);
        if (standard.emissive && selected !== undefined) standard.emissiveIntensity = name === selected ? 1 : 0;
        if (standard.emissive && name === selected) standard.emissive.setRGB(0.1, 0.35, 0.3);
        else if (standard.emissive && selected !== undefined) standard.emissive.setRGB(0, 0, 0);
      }
    });
    r.grid.visible = showGrid; r.axes.visible = showGrid; r.dirty = true;
  }, [objects, wire, xray, selected, showGrid, loaded]);

  useEffect(() => {
    const r = runtime.current;
    if (!r) return;
    r.overlay.clear(); r.dirty = true;
    const list = model?.rays?.length ? model.rays : model?.ray ? [model.ray] : [];
    if (!showRay) return;
    list.forEach((ray, i) => {
    const origin = vec(ray.origin), end = ray.hit ? vec(ray.hit) : vec(ray.target);
    const color = ray.visible ? 0x5ce0a8 : 0xff7a45;
    const geometry = new THREE.BufferGeometry().setFromPoints([origin, origin.clone()]);
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color }));
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), new THREE.MeshBasicMaterial({ color }));
    const lens = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.34, 4), new THREE.MeshBasicMaterial({ color: 0xe8f1f0, wireframe: true }));
    lens.position.copy(origin); lens.lookAt(end); lens.rotateX(Math.PI / 2);
    dot.position.copy(end); dot.scale.setScalar(0.001);
    r.overlay.add(line, dot, lens);
    if (!ray.visible) {
      const intended = new THREE.Line(new THREE.BufferGeometry().setFromPoints([end, vec(ray.target)]),
        new THREE.LineDashedMaterial({ color: 0xffc27a, dashSize: 0.12, gapSize: 0.08 }));
      intended.computeLineDistances(); r.overlay.add(intended);
    }
    const start = performance.now() + i * 160;
    r.animations.push({ start, duration: 700 + i * 160, apply: () => {
      const t = Math.max(0, Math.min(1, (performance.now() - start) / 700));
      const p = origin.clone().lerp(end, 1 - Math.pow(1 - t, 2));
      geometry.setFromPoints([origin, p]); dot.scale.setScalar(Math.max(0.001, t));
    } });
    });
  }, [model?.ray, model?.rays, showRay, model?.key]);

  useEffect(() => {
    const r = runtime.current;
    if (!r) return;
    const { center, scale: k } = r.fit, target = center.clone(), from = r.camera.position.clone(), fromTarget = r.controls.target.clone();
    const at = (x: number, y: number, z: number) => center.clone().add(new THREE.Vector3(x, y - 0.6, z).multiplyScalar(k));
    const positions: Record<View, THREE.Vector3> = {
      persp: at(6.5 * (k > 1 ? 0.62 : 1), 5.2 * (k > 1 ? 0.62 : 1) + 0.6, 7.5 * (k > 1 ? 0.62 : 1)), top: at(0, 11, 0.001), front: at(0, 1.2, 8.5),
      right: at(8.5, 1.2, 0), camera: model?.ray ? vec(model.ray.origin) : new THREE.Vector3(3.6, 3.4, 4.8),
    };
    const to = positions[view], toTarget = view === "camera" && model?.ray ? vec(model.ray.target) : target;
    r.animations.push({ start: performance.now(), duration: 520, apply: t => {
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      r.camera.position.lerpVectors(from, to, e); r.controls.target.lerpVectors(fromTarget, toTarget, e);
    } });
  }, [view]);

  useEffect(() => {
    const listener = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (VIEWS.some(v => v.id === detail)) setView(detail as View);
      if (detail === "wire") setWire(w => !w);
      if (detail === "xray") setXray(x => !x);
    };
    window.addEventListener("pai-view", listener);
    return () => window.removeEventListener("pai-view", listener);
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const v = VIEWS.find(x => x.key === e.key);
    if (v) { setView(v.id); e.preventDefault(); }
    if (e.key.toLowerCase() === "z" && e.altKey) { setXray(x => !x); e.preventDefault(); }
    else if (e.key.toLowerCase() === "z") setWire(w => !w);
    if (e.key.toLowerCase() === "f") setView("persp");
    if (e.key.toLowerCase() === "m" && !e.ctrlKey && !e.metaKey && !e.altKey) { setMaximized(m => !m); e.preventDefault(); }
  };
  const footprint = objects.find(o => o.name === "Workcell footprint");
  const inspected = objects.find(o => o.name === selected);
  const ray = model?.ray;
  return <div ref={rootRef} className={`viewport${maximized ? " maximized" : ""}${panel ? "" : " no-side"}`} onKeyDown={onKey}
    {...(maximized ? { role: "dialog", "aria-modal": true, "aria-label": "三维视口（最大化，Esc 还原）" } : {})} data-webgl={webgl} data-objects={objects.length}
    data-stage={activeIndex !== undefined ? stages[activeIndex].index : stages.length} data-ray={ray ? (ray.visible ? "target" : "blocked") : "none"} data-animations={clips} data-playing={playing}>
    <div className="viewport-canvas" ref={host}>
      {webgl === "unavailable" && <div className="viewport-fallback">此浏览器未启用 WebGL；原生渲染图与下载文件不受影响。</div>}
      {webgl === "ok" && !url && <div className="viewport-empty"><strong>实时原生视口</strong><span>提交候选或在 AI 助手中确认计划后，原生工具每完成一个构建阶段，这里即时出现对应的几何。</span></div>}
      <div className="viewport-hud top-left">
        <span className={`live-dot ${model?.running ? "on" : ""}`} />{model?.running ? `LIVE · ${model.units === "mm" ? "CadQuery" : "Blender"} 原生构建中` : model ? model.title : "等待原生任务"}
        {model && <small>{model.which === "baseline" ? (model.units === "mm" ? "基准零件" : "基准布局") : (model.units === "mm" ? "候选零件" : "候选布局")} · {activeIndex !== undefined ? `阶段 ${stages[activeIndex].index}/${stages.length}` : model.finalUrl ? "最终 GLB（摘要已核验）" : `阶段 ${stages.length}`}</small>}
      </div>
      <div className="viewport-hud top-right" role="toolbar" aria-label="视图预设">
        {VIEWS.map(v => <button key={v.id} type="button" className={view === v.id ? "active" : ""} aria-pressed={view === v.id} title={`快捷键 ${v.key}`} onClick={() => setView(v.id)}>{v.label}</button>)}
        <span className="hud-sep" aria-hidden="true" />
        <button type="button" className={panel ? "active" : ""} aria-pressed={panel} title="大纲与检查器" onClick={() => setPanel(x => !x)}>大纲</button>
        <button ref={maxButton} type="button" className="hud-max" aria-pressed={maximized} aria-label={maximized ? "还原视口" : "最大化视口"}
          title={maximized ? "还原（Esc / M）" : "最大化（M）"} onClick={() => setMaximized(m => !m)}>{maximized ? "⤡ 还原" : "⤢ 最大化"}</button>
      </div>
      {ray && !model?.rays?.length && <div className={`viewport-hud bottom-left ray-badge ${ray.visible ? "ok" : "blocked"}`}>原生射线首个命中：{ray.firstHit === "Target" ? "目标" : ray.firstHit ?? "无"}{ray.visible ? " · 可见" : " · 被遮挡"}</div>}
      {model?.rays?.length ? <div className={`viewport-hud bottom-left ray-badge ${model.rays.every(x => x.visible) ? "ok" : "blocked"}`}>检测相机射线：{model.rays.filter(x => x.visible).length}/{model.rays.length} 个工位首个命中为工件</div> : null}
      {clips > 0 && !model?.running && <div className="viewport-hud bottom-right anim"><button type="button" className={playing ? "active" : ""} aria-pressed={playing} onClick={() => setPlaying(p => !p)}>
        {playing ? "❚❚ 暂停动画" : "▶ 播放产线动画"}</button><small>原生关键帧 · {clips} 段 · 演示用运动，非动力学</small></div>}
      {model?.render && !(clips > 0 && !model.running) && <div className="viewport-hud bottom-right render-progress" role="progressbar" aria-label="Cycles 渲染采样" aria-valuemin={0} aria-valuemax={model.render.samples} aria-valuenow={model.render.sample}>
        <span>Cycles {model.render.sample}/{model.render.samples}</span><i style={{ width: `${(model.render.sample / model.render.samples) * 100}%` }} /></div>}
    </div>
    <div className="viewport-side" hidden={!panel}>
      <div className="outliner"><strong>大纲 · Outliner</strong>
        {objects.length === 0 ? <p>尚无原生几何</p> : <ul>{objects.map(o => <li key={o.name} className={selected === o.name ? "selected" : ""}>
          <label className="check"><input type="checkbox" checked={o.visible} aria-label={`显示 ${o.name}`} onChange={e => setObjects(list => list.map(x => x.name === o.name ? { ...x, visible: e.target.checked } : x))} /></label>
          <button type="button" onClick={() => setSelected(s => s === o.name ? undefined : o.name)}>{o.name}</button></li>)}</ul>}
      </div>
      <div className="inspector"><strong>检查器</strong>
        {inspected ? <p>{inspected.name}<br />{inspected.size.map(n => n.toFixed(unit === "mm" ? 1 : 2)).join(" × ")} {unit}（包围盒）</p>
          : unit === "mm" && objects[0] ? <p>{objects[0].name}<br />{objects[0].size.map(n => n.toFixed(1)).join(" × ")} mm（包围盒）</p>
          : footprint ? <p>占地包围盒 {footprint.size[0].toFixed(2)} × {footprint.size[2].toFixed(2)} m</p> : <p>选择对象查看尺寸</p>}
        <div className="toggles">
          <label className="check"><input type="checkbox" checked={wire} onChange={e => setWire(e.target.checked)} />线框 (Z)</label>
          <label className="check"><input type="checkbox" checked={xray} onChange={e => setXray(e.target.checked)} />X 光透视 (Alt+Z)</label>
          <label className="check"><input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} />网格与坐标轴</label>
          <label className="check"><input type="checkbox" checked={showRay} onChange={e => setShowRay(e.target.checked)} />射线叠加</label>
        </div>
      </div>
    </div>
    {stages.length > 0 && <div className="scrubber"><span>构建阶段</span>
      <input type="range" min={0} max={stages.length} value={activeIndex ?? stages.length} aria-label="构建阶段时间轴"
        onChange={e => { const v = Number(e.target.value); setScrub(v >= stages.length ? undefined : v); runtime.current?.known.clear(); }} />
      <small>{activeIndex !== undefined ? `${stages[activeIndex].index}. ${stages[activeIndex].label}` : model?.finalUrl ? "最终原生场景" : `${stages.at(-1)?.index}. ${stages.at(-1)?.label}`}</small></div>}
  </div>;
}
