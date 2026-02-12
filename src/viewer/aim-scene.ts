/**
 * Three.js 3D scene manager for aim vector visualization.
 *
 * Renders map ground plane, object markers, player movement path,
 * and fire event aim rays in an interactive 3D view.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ── Types ──

export interface MapObject3D {
  name: string;
  position: { x: number; y: number; z: number };
}

export interface PathPoint {
  x: number;
  y: number;
}

export interface AimRay {
  /** World position where the shot was fired */
  origin: { x: number; y: number };
  /** Unit direction vector */
  direction: { x: number; y: number; z: number };
  /** Weapon name for color-coding */
  weaponName: string;
  /** Index in the fire events array */
  index: number;
}

// ── Weapon color palette ──

const WEAPON_COLORS: Record<string, number> = {
  'MA40 AR': 0x4fc3f7,
  'Mk51 Sidekick': 0xf06292,
  'BR75': 0xaed581,
  'M392 Bandit': 0xffb74d,
  'VK78 Commando': 0xba68c8,
  'S7 Sniper': 0xe57373,
  'CQS48 Bulldog': 0x81c784,
  'M41 SPNKr': 0xff8a65,
  'Needler': 0x4dd0e1,
  'Pulse Carbine': 0x7c4dff,
  'Plasma Pistol': 0x69f0ae,
  'Sentinel Beam': 0xffd740,
  'Heatwave': 0xff5252,
  'Stalker Rifle': 0xb388ff,
  'Shock Rifle': 0x448aff,
  'Mangler': 0xff6e40,
  'Disruptor': 0x40c4ff,
  'Ravager': 0xea80fc,
  'Skewer': 0xccff90,
  'Cindershot': 0xff9100,
  'Hydra': 0x84ffff,
  'Gravity Hammer': 0xffe57f,
  'Energy Sword': 0x80d8ff,
  'Frag Grenade': 0xa5d6a7,
  'Plasma Grenade': 0x80cbc4,
};

function getWeaponColor(name: string): number {
  return WEAPON_COLORS[name] ?? 0x9e9e9e;
}

// ── Scene Manager ──

export class AimScene {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;

  private objectsGroup: THREE.Group;
  private pathGroup: THREE.Group;
  private raysGroup: THREE.Group;

  private allRayData: AimRay[] = [];
  private rayLength = 10;
  private weaponFilter = '';

  constructor(container: HTMLElement) {
    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d1117);

    // Use container dimensions, falling back to window size if layout hasn't computed yet
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || (window.innerHeight - 100);

    // Camera
    const aspect = w / Math.max(h, 1);
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 10000);

    // Renderer (Three.js 0.162 supports both WebGL2 and WebGL1 fallback)
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;

    // Groups
    this.objectsGroup = new THREE.Group();
    this.pathGroup = new THREE.Group();
    this.raysGroup = new THREE.Group();
    this.scene.add(this.objectsGroup);
    this.scene.add(this.pathGroup);
    this.scene.add(this.raysGroup);

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);
    const directional = new THREE.DirectionalLight(0xffffff, 0.4);
    directional.position.set(50, 100, 50);
    this.scene.add(directional);

    // Resize handling
    const resizeObserver = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    // Render loop
    const animate = () => {
      requestAnimationFrame(animate);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  /**
   * Build the ground plane grid from map bounds.
   */
  buildGround(minX: number, maxX: number, minY: number, maxY: number): void {
    const w = maxX - minX;
    const h = maxY - minY;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const size = Math.max(w, h);

    // Grid helper centered on map
    const grid = new THREE.GridHelper(size * 1.2, 20, 0x30363d, 0x21262d);
    grid.position.set(cx, 0, cy);
    this.scene.add(grid);

    // Map bounds outline
    const boundsGeo = new THREE.BufferGeometry();
    const corners = new Float32Array([
      minX, 0.01, minY,
      maxX, 0.01, minY,
      maxX, 0.01, maxY,
      minX, 0.01, maxY,
      minX, 0.01, minY,
    ]);
    boundsGeo.setAttribute('position', new THREE.BufferAttribute(corners, 3));
    const boundsMat = new THREE.LineBasicMaterial({ color: 0x30363d, linewidth: 2 });
    this.scene.add(new THREE.Line(boundsGeo, boundsMat));

    // Position camera above map looking down at ~45°
    this.camera.position.set(cx, size * 0.8, cy + size * 0.6);
    this.controls.target.set(cx, 0, cy);
    this.controls.update();
  }

  /**
   * Add map objects as colored spheres.
   */
  buildObjects(objects: MapObject3D[]): void {
    for (const obj of objects) {
      let color = 0x666666;
      let radius = 0.8;

      if (obj.name.includes('Spawn Point [Initial]')) {
        color = 0x00ff00;
        radius = 1.2;
      } else if (obj.name.includes('Spawn Point [Respawn]')) {
        continue;
      } else if (obj.name.includes('Flag')) {
        color = 0xffcc00;
        radius = 1.0;
      } else if (obj.name.includes('Zone') || obj.name.includes('Capture') || obj.name.includes('Ball')) {
        continue;
      } else if (isWeaponObj(obj.name)) {
        color = 0xff6666;
        radius = 1.0;
      } else if (isEquipmentObj(obj.name)) {
        color = 0xcc66ff;
        radius = 1.0;
      } else {
        continue;
      }

      const geo = new THREE.SphereGeometry(radius, 12, 8);
      const mat = new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.7 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(obj.position.x, obj.position.z || 0.5, obj.position.y);
      this.objectsGroup.add(mesh);
    }
  }

  /**
   * Add player movement path as a line on the ground.
   */
  buildPath(points: PathPoint[]): void {
    if (points.length < 2) return;

    const positions = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      positions[i * 3] = points[i].x;
      positions[i * 3 + 1] = 0.2; // slightly above ground
      positions[i * 3 + 2] = points[i].y;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.LineBasicMaterial({ color: 0x3b82f6, linewidth: 1 });
    this.pathGroup.add(new THREE.Line(geo, mat));

    // Start marker
    const startGeo = new THREE.SphereGeometry(1, 16, 12);
    const startMat = new THREE.MeshLambertMaterial({ color: 0x00ff00 });
    const startMesh = new THREE.Mesh(startGeo, startMat);
    startMesh.position.set(points[0].x, 0.5, points[0].y);
    this.pathGroup.add(startMesh);

    // End marker
    const endGeo = new THREE.SphereGeometry(0.8, 16, 12);
    const endMat = new THREE.MeshLambertMaterial({ color: 0xff4444 });
    const endMesh = new THREE.Mesh(endGeo, endMat);
    const last = points[points.length - 1];
    endMesh.position.set(last.x, 0.5, last.y);
    this.pathGroup.add(endMesh);
  }

  /**
   * Build aim rays from fire events.
   */
  buildRays(rays: AimRay[]): void {
    this.allRayData = rays;
    this.rebuildRays();
  }

  private rebuildRays(): void {
    // Clear existing
    while (this.raysGroup.children.length > 0) {
      const child = this.raysGroup.children[0];
      this.raysGroup.remove(child);
      if (child instanceof THREE.ArrowHelper) {
        child.dispose();
      }
    }

    for (const ray of this.allRayData) {
      if (this.weaponFilter && ray.weaponName !== this.weaponFilter) continue;

      const color = getWeaponColor(ray.weaponName);

      // Map aim direction: film X→scene X, film Y→scene Z, film Z→scene Y (up)
      const dir = new THREE.Vector3(ray.direction.x, ray.direction.z, ray.direction.y);
      dir.normalize();

      const origin = new THREE.Vector3(ray.origin.x, 1.5, ray.origin.y);

      const arrow = new THREE.ArrowHelper(
        dir,
        origin,
        this.rayLength,
        color,
        this.rayLength * 0.15,
        this.rayLength * 0.06,
      );
      this.raysGroup.add(arrow);
    }
  }

  // ── Interactive controls ──

  setRayLength(length: number): void {
    this.rayLength = length;
    this.rebuildRays();
  }

  setMapObjectsVisible(visible: boolean): void {
    this.objectsGroup.visible = visible;
  }

  setPathsVisible(visible: boolean): void {
    this.pathGroup.visible = visible;
  }

  filterByWeapon(weaponName: string): void {
    this.weaponFilter = weaponName;
    this.rebuildRays();
  }

  getVisibleRayCount(): number {
    return this.raysGroup.children.length;
  }
}

// ── Helpers ──

function isWeaponObj(name: string): boolean {
  const keywords = [
    'Weapon', 'Gun', 'Rifle', 'Pistol', 'Shotgun', 'Sniper',
    'Rocket', 'Sword', 'Hammer', 'Needler', 'Plasma', 'BR',
    'DMR', 'Commando', 'Sidekick', 'Mangler', 'Bulldog', 'Heatwave',
    'Shock', 'Stalker', 'Skewer', 'Cindershot', 'Ravager', 'Hydra',
    'Sentinel', 'Disruptor',
  ];
  return keywords.some(k => name.includes(k));
}

function isEquipmentObj(name: string): boolean {
  const keywords = [
    'Equipment', 'Grenade', 'Overshield', 'Camo', 'Grapple',
    'Thruster', 'Repulsor', 'Drop Wall', 'Threat Sensor',
  ];
  return keywords.some(k => name.includes(k));
}
