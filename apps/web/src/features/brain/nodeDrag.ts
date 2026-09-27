// Knoten greifen und ziehen: Klicken-halten-ziehen auf einem Knoten bewegt DIESEN Knoten in
// 3D — in der Ebene durch den Knoten, parallel zum Bildschirm (so bleibt er unter der Maus und behält
// seine Tiefe). Die Physik hält ihn dort fest (fx/fy/fz) und zieht die Nachbarn mit; beim Loslassen
// wird er freigegeben und federt sanft in die Wolke zurück.
import { Vector3 } from "three";

/** Schnittpunkt Strahl ↔ Ebene (Punkt + Normale); null, wenn parallel oder hinter dem Ursprung. */
export function rayPlaneHit(origin: Vector3, dir: Vector3, planePoint: Vector3, normal: Vector3): Vector3 | null {
  const denom = dir.dot(normal);
  if (Math.abs(denom) < 1e-6) return null;
  const t = new Vector3().subVectors(planePoint, origin).dot(normal) / denom;
  if (!(t > 0)) return null;
  return origin.clone().addScaledVector(dir, t);
}
