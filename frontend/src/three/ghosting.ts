/**
 * Режим «рентгена» (п. 3.2 ТЗ): при выборе объекта вся остальная модель
 * становится полупрозрачной, а выбранный подсвечивается.
 */
import * as THREE from 'three'

const ORIGINAL = '__originalMaterial'

let ghostMaterial: THREE.MeshStandardMaterial | null = null
let highlightMaterial: THREE.MeshStandardMaterial | null = null

function getGhostMaterial(): THREE.MeshStandardMaterial {
  if (!ghostMaterial) {
    ghostMaterial = new THREE.MeshStandardMaterial({
      color: 0x8fa3b8,
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide,
    })
  }
  return ghostMaterial
}

function getHighlightMaterial(): THREE.MeshStandardMaterial {
  if (!highlightMaterial) {
    highlightMaterial = new THREE.MeshStandardMaterial({
      color: 0x2f81f7,
      emissive: 0x1b4f9c,
      emissiveIntensity: 0.55,
      roughness: 0.45,
      metalness: 0.05,
      side: THREE.DoubleSide,
    })
  }
  return highlightMaterial
}

export function collectMeshes(root: THREE.Object3D | null): THREE.Mesh[] {
  if (!root) return []
  const meshes: THREE.Mesh[] = []
  root.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh)
  })
  return meshes
}

function rememberOriginal(mesh: THREE.Mesh): void {
  if (mesh.userData[ORIGINAL] === undefined) {
    mesh.userData[ORIGINAL] = mesh.material
  }
}

/**
 * @param root       корень загруженной .glb-модели
 * @param highlight  меш, который надо подсветить (или null — просто приглушить всё)
 * @param ghostAll   true — приглушать всё, включая highlight-меш
 */
export function applyXray(
  root: THREE.Object3D | null,
  highlight: THREE.Mesh | null,
  ghostAll = false,
): void {
  for (const mesh of collectMeshes(root)) {
    rememberOriginal(mesh)
    if (!ghostAll && highlight && mesh === highlight) {
      mesh.material = getHighlightMaterial()
    } else {
      mesh.material = getGhostMaterial()
    }
  }
}

export function clearXray(root: THREE.Object3D | null): void {
  for (const mesh of collectMeshes(root)) {
    const original = mesh.userData[ORIGINAL]
    if (original) {
      mesh.material = original as THREE.Material | THREE.Material[]
      delete mesh.userData[ORIGINAL]
    }
  }
}

export function findMeshByName(root: THREE.Object3D | null, name: string | null): THREE.Mesh | null {
  if (!root || !name) return null
  const found = root.getObjectByName(name)
  return found && (found as THREE.Mesh).isMesh ? (found as THREE.Mesh) : null
}

/** Рамка модели — чтобы поставить камеру так, чтобы объект целиком попал в кадр. */
export function fitCameraToObject(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  offset = 1.5,
): { target: THREE.Vector3; distance: number } {
  const box = new THREE.Box3().setFromObject(object)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())

  const maxSize = Math.max(size.x, size.y, size.z) || 10
  const fitHeightDistance = maxSize / (2 * Math.atan((Math.PI * camera.fov) / 360))
  const fitWidthDistance = fitHeightDistance / camera.aspect
  const distance = offset * Math.max(fitHeightDistance, fitWidthDistance)

  const direction = new THREE.Vector3(1, 0.75, 1).normalize().multiplyScalar(distance)
  camera.position.copy(center.clone().add(direction))
  camera.near = Math.max(distance / 500, 0.05)
  camera.far = distance * 20
  camera.updateProjectionMatrix()
  camera.lookAt(center)

  return { target: center, distance }
}
