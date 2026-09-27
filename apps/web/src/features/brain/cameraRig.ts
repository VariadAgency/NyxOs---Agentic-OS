// Kamera-Rig für das Umkreisen — ersetzt OrbitControls. Eingaben verschieben ein ZIEL
// (Winkel, Abstand, Mittelpunkt); die echte Kamera folgt ihm jedes Bild weich (Dämpfung). Nach dem
// Loslassen einer Maus-Drehung dreht sie mit Schwung weiter und läuft aus (Trägheit). Zoom geht zum
// Punkt unter der Maus: Ziel UND Abstand wandern gemeinsam, deshalb bleibt dieser Punkt auch während
// des Gleitens an derselben Bildschirmstelle.
import { Spherical, Vector3, type PerspectiveCamera } from "three";

/** Wie schnell Abstand und Mittelpunkt dem Ziel folgen (1/s) — ~55 ms: Zoom bleibt, wie er gefiel. */
export const SMOOTH_RATE = 18;
/** Drehen gleitet weich an (~140 ms, wie Karten-Apps) — einzelne Trackpad-Ereignisse
 * verschmelzen zu einer ruhigen Bewegung statt zu ruckeln. Ohne Überschwingen (reine Dämpfung). */
/** Inzwischen noch weicher (~220 ms): ruhiger und langsamer. */
export const ROTATE_SMOOTH_RATE = 4.5;
/** Wie schnell der Schwung nach dem Loslassen ausläuft (1/s) — etwas länger, dafür sanfter. */
/** Längeres, sanftes Auslaufen. */
export const INERTIA_DECAY = 1.6;
/** Schneller als das dreht auch ein kräftiger Wurf nicht (rad/s); vorher 6 = Wegschleudern. */
/** Langsamer (vorher 2,2). */
export const MAX_FLING = 1.4;
const PHI_MIN = 0.02;
const PHI_MAX = Math.PI - 0.02;
const EPS = 1e-5;

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const Y_AXIS = new Vector3(0, 1, 0);

export class OrbitRig {
  /** Aktueller Mittelpunkt (dahin schaut die Kamera). */
  readonly target = new Vector3();
  private readonly goalTarget = new Vector3();
  private readonly cur = new Spherical(1000, Math.PI / 2, 0);
  private readonly goal = new Spherical(1000, Math.PI / 2, 0);
  private velTheta = 0;
  private velPhi = 0;
  private readonly minRadius: number;
  private readonly maxRadius: number;
  private readonly tmp = new Vector3();
  private readonly axis = new Vector3();
  private readonly pivotPoint = new Vector3();
  /** Drehpunkt der letzten Drehung (für den Schwung); null = um das Blickziel. */
  private pivot: Vector3 | null = null;
  /** Das Blickziel folgt gerade einer Drehung: gleich weich wie die Winkel, sonst eiert die Bahn. */
  private rotatingTarget = false;

  constructor(opts: { minRadius: number; maxRadius: number }) {
    this.minRadius = opts.minRadius;
    this.maxRadius = opts.maxRadius;
  }

  /** Sofort dorthin (ohne Gleiten), Schwung weg — nach Übergängen, Einpassen, Flug-Modus. */
  jumpTo(position: Vector3, target: Vector3): void {
    this.target.copy(target);
    this.goalTarget.copy(target);
    this.cur.setFromVector3(this.tmp.copy(position).sub(target));
    if (this.cur.radius < EPS) this.cur.set(this.minRadius, Math.PI / 2, 0);
    this.cur.phi = clamp(this.cur.phi, PHI_MIN, PHI_MAX);
    this.goal.copy(this.cur);
    this.pivot = null;
    this.rotatingTarget = false;
    this.stop();
  }

  /** Schwung anhalten (z. B. beim Anfassen). */
  stop(): void {
    this.velTheta = 0;
    this.velPhi = 0;
  }

  /**
   * Drehen (rad). Positiv dTheta = Kamera wandert nach links um das Ziel. Mit `pivot` dreht die ganze
   * Kamera samt Blickziel starr um diesen Punkt (z. B. die Mitte der Wolke) — die Kugel dreht sich, ohne
   * dass die Kamera erst zur Mitte schwenkt oder sich seitlich verschiebt. Der Schwung danach nutzt
   * denselben Drehpunkt.
   */
  rotate(dTheta: number, dPhi: number, pivot?: Vector3 | null): void {
    if (pivot !== undefined) this.pivot = pivot ? this.pivotPoint.copy(pivot) : null;
    const phi0 = this.goal.phi;
    this.goal.theta += dTheta;
    this.goal.phi = clamp(phi0 + dPhi, PHI_MIN, PHI_MAX);
    const p = this.pivot;
    if (!p || this.goalTarget.distanceToSquared(p) < 1e-8) return;
    // Blickziel mitdrehen: Gieren um die Hochachse durch den Drehpunkt, Nicken um die waagrechte Achse
    // quer zur Blickrichtung (genau die Achse, um die sich der Kamera-Versatz beim Ändern von phi dreht).
    const rel = this.tmp.copy(this.goalTarget).sub(p);
    if (dTheta !== 0) rel.applyAxisAngle(Y_AXIS, dTheta);
    const applied = this.goal.phi - phi0;
    if (applied !== 0) rel.applyAxisAngle(this.axis.set(Math.cos(this.goal.theta), 0, -Math.sin(this.goal.theta)), applied);
    this.goalTarget.copy(p).add(rel);
    this.rotatingTarget = true;
  }

  /** Schwung nach dem Loslassen (rad/s). */
  fling(vTheta: number, vPhi: number): void {
    this.velTheta = clamp(vTheta, -MAX_FLING, MAX_FLING);
    this.velPhi = clamp(vPhi, -MAX_FLING, MAX_FLING);
  }

  /** Schwenken um Bildschirm-Pixel: der Inhalt folgt der Maus. */
  pan(dxPx: number, dyPx: number, camera: PerspectiveCamera, viewHeightPx: number): void {
    const perPx = (2 * this.goal.radius * Math.tan(((camera.fov / 2) * Math.PI) / 180)) / Math.max(1, viewHeightPx);
    const right = this.tmp.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    this.goalTarget.addScaledVector(right, -dxPx * perPx);
    const up = right.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    this.goalTarget.addScaledVector(up, dyPx * perPx);
    this.rotatingTarget = false;
  }

  /** Näher (factor < 1) oder weiter weg; mit `anchor` zum Punkt unter der Maus hin. */
  zoom(factor: number, anchor: Vector3 | null): void {
    const r0 = this.goal.radius;
    const r1 = clamp(r0 * factor, this.minRadius, this.maxRadius);
    if (anchor) {
      this.goalTarget.lerp(anchor, 1 - r1 / r0);
      this.rotatingTarget = false;
    }
    this.goal.radius = r1;
  }

  /** Mittelpunkt und Kamera gemeinsam verschieben (WASD im Umkreisen-Modus). */
  translate(v: Vector3): void {
    this.target.add(v);
    this.goalTarget.add(v);
  }

  /**
   * Neuer Drehpunkt (damit sich die Wolke wie ein Globus dreht), ohne dass die Kamera springt — sie bleibt
   * (fast) stehen und schaut weich zum neuen Mittelpunkt; danach dreht alles um ihn.
   */
  repivot(target: Vector3, cameraPos: Vector3): void {
    if (this.goalTarget.distanceToSquared(target) < 1e-6) return;
    this.goalTarget.copy(target);
    const theta = this.goal.theta;
    this.goal.setFromVector3(this.tmp.copy(cameraPos).sub(target));
    if (this.goal.radius < EPS) this.goal.radius = this.minRadius;
    this.goal.radius = clamp(this.goal.radius, this.minRadius, this.maxRadius);
    this.goal.phi = clamp(this.goal.phi, PHI_MIN, PHI_MAX);
    // Winkel nah am bisherigen halten (kein Umweg über ±π).
    this.goal.theta += Math.round((theta - this.goal.theta) / (2 * Math.PI)) * 2 * Math.PI;
  }

  /** Abstand des Ziel-Mittelpunkts zu `p`. */
  goalTargetDistance(p: Vector3): number {
    return this.goalTarget.distanceTo(p);
  }

  radius(): number {
    return this.goal.radius;
  }

  /** Ein Bild weiter. */
  update(dt: number): void {
    if (this.velTheta !== 0 || this.velPhi !== 0) {
      this.rotate(this.velTheta * dt, this.velPhi * dt);
      const k = Math.exp(-INERTIA_DECAY * dt);
      this.velTheta *= k;
      this.velPhi *= k;
      if (Math.abs(this.velTheta) < 0.004 && Math.abs(this.velPhi) < 0.004) this.stop();
    }
    const a = 1 - Math.exp(-SMOOTH_RATE * dt);
    const ar = 1 - Math.exp(-ROTATE_SMOOTH_RATE * dt);
    this.cur.theta += (this.goal.theta - this.cur.theta) * ar;
    this.cur.phi += (this.goal.phi - this.cur.phi) * ar;
    this.cur.radius += (this.goal.radius - this.cur.radius) * a;
    this.target.lerp(this.goalTarget, this.rotatingTarget ? ar : a);
    // Am Ziel einrasten, damit „bewegt sich noch“ sauber endet.
    if (!this.moving()) {
      this.cur.copy(this.goal);
      this.target.copy(this.goalTarget);
      this.rotatingTarget = false;
    }
  }

  moving(): boolean {
    return (
      this.velTheta !== 0 ||
      this.velPhi !== 0 ||
      Math.abs(this.goal.theta - this.cur.theta) > EPS ||
      Math.abs(this.goal.phi - this.cur.phi) > EPS ||
      Math.abs(this.goal.radius - this.cur.radius) > this.cur.radius * EPS ||
      this.goalTarget.distanceToSquared(this.target) > (this.cur.radius * EPS) ** 2
    );
  }

  apply(camera: PerspectiveCamera): void {
    camera.position.setFromSpherical(this.cur).add(this.target);
    camera.lookAt(this.target);
    camera.updateMatrixWorld();
  }
}
