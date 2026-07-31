/**
 * Поиск деталей модели и вписывание камеры в её габариты.
 *
 * Режим «рентгена» (п. 3.2 ТЗ) — приглушение модели и подсветка выбранной
 * детали — переехал в three/batching: рисуются не исходные меши, а слитая
 * копия геометрии, и материалы теперь переключаются на ней.
 */
import * as THREE from 'three'

/**
 * Кэш списка мешей по корню модели.
 *
 * Обход дерева из тысяч узлов стоит миллисекунды, а состав загруженной
 * модели не меняется. WeakMap — чтобы выгруженный слой уходил из памяти
 * вместе со своим списком.
 */
const meshCache = new WeakMap<THREE.Object3D, THREE.Mesh[]>()

export function collectMeshes(root: THREE.Object3D | null): THREE.Mesh[] {
  if (!root) return []
  const cached = meshCache.get(root)
  if (cached) return cached
  const meshes: THREE.Mesh[] = []
  root.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh)
  })
  meshCache.set(root, meshes)
  return meshes
}

/** Забыть кэш — вызывается при выгрузке слоя. */
export function forgetMeshes(root: THREE.Object3D | null): void {
  if (root) meshCache.delete(root)
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
  return fitCameraToObjects(camera, [object], offset)
}

/**
 * То же для нескольких слоёв: в кадр вписывается их общая рамка.
 *
 * Слои .glb выгружены из одного проекта и лежат в общих координатах, но
 * вписывать камеру по одному из них нельзя — инженерная модель может быть
 * заметно меньше архитектурной и «сброс вида» уводил бы камеру вплотную.
 */
export function fitCameraToObjects(
  camera: THREE.PerspectiveCamera,
  objects: THREE.Object3D[],
  offset = 1.5,
): { target: THREE.Vector3; distance: number } {
  const box = new THREE.Box3()
  for (const object of objects) box.expandByObject(object)
  if (box.isEmpty()) {
    // Пустая сцена: оставляем камеру там, где она стоит, и смотрим в центр.
    return { target: new THREE.Vector3(0, 0, 0), distance: camera.position.length() || 10 }
  }
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())

  const maxSize = Math.max(size.x, size.y, size.z) || 10
  const fitHeightDistance = maxSize / (2 * Math.atan((Math.PI * camera.fov) / 360))
  // Канвас мог ещё не получить размеры — тогда aspect равен 0 или NaN, и
  // деление на него даёт бесконечную дистанцию. Дальше в камеру уходят NaN,
  // OrbitControls.update() падает на каждом кадре, и вместе с ним встают
  // 3D-виджеты. Поэтому в такой момент считаем кадр квадратным.
  const aspect = Number.isFinite(camera.aspect) && camera.aspect > 0 ? camera.aspect : 1
  const fitWidthDistance = fitHeightDistance / aspect
  const raw = offset * Math.max(fitHeightDistance, fitWidthDistance)
  const distance = Number.isFinite(raw) && raw > 0 ? raw : 10

  const direction = new THREE.Vector3(1, 0.75, 1).normalize().multiplyScalar(distance)
  camera.position.copy(center.clone().add(direction))
  camera.near = Math.max(distance / 500, 0.05)
  camera.far = distance * 20
  camera.updateProjectionMatrix()
  camera.lookAt(center)

  return { target: center, distance }
}
