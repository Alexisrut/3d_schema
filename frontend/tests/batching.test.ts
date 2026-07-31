/**
 * Тесты слияния геометрии модели в рендер-прокси.
 * Запуск:  node tests/run.mjs
 *
 * Проверяется главное обещание оптимизации: картинка та же, вызовов
 * отрисовки меньше, а исходные меши остаются пригодными для выбора.
 */
import assert from 'node:assert/strict'
import * as THREE from 'three'

import { buildRenderProxy } from '../src/three/batching'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${name}`)
    console.error(`    ${(error as Error).message}`)
  }
}

function close(actual: number, expected: number, tolerance = 1e-4): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `ожидалось ${expected}, получено ${actual}`)
}

/** Модель из кубов на общем материале — типичная выгрузка из САПР. */
function buildModel(count: number, material?: THREE.Material): THREE.Object3D {
  const shared = material ?? new THREE.MeshStandardMaterial({ color: 0xcccccc })
  const root = new THREE.Group()
  root.name = 'модель'
  for (let i = 0; i < count; i += 1) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared)
    mesh.name = `деталь-${i}`
    mesh.position.set(i * 2, 0, 0)
    root.add(mesh)
  }
  root.updateMatrixWorld(true)
  return root
}

/** Габариты объекта в мировых координатах. */
function worldBox(object: THREE.Object3D): THREE.Box3 {
  object.updateMatrixWorld(true)
  return new THREE.Box3().setFromObject(object)
}

function drawnMeshes(group: THREE.Object3D): THREE.Mesh[] {
  const list: THREE.Mesh[] = []
  group.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) list.push(child as THREE.Mesh)
  })
  return list
}

console.log('batching.ts — слияние геометрии')

test('детали на общем материале сливаются в один меш', () => {
  const root = buildModel(50)
  const proxy = buildRenderProxy(root)
  assert.ok(proxy)
  assert.equal(proxy!.batchCount, 1, 'ожидался один вызов отрисовки вместо 50')
})

test('слитая геометрия содержит все треугольники исходных деталей', () => {
  const root = buildModel(12)
  const proxy = buildRenderProxy(root)!
  const batch = drawnMeshes(proxy.group)[0]
  // Куб BoxGeometry — 24 вершины и 36 индексов; 12 кубов дают ровно 12×.
  assert.equal(batch.geometry.getAttribute('position').count, 12 * 24)
  assert.equal(batch.geometry.index!.count, 12 * 36)
})

test('габариты слитой модели совпадают с исходными', () => {
  const root = buildModel(20)
  const before = worldBox(root)
  const proxy = buildRenderProxy(root)!
  // Прокси встаёт рядом с корнем в общем контейнере — воспроизводим это.
  const container = new THREE.Group()
  root.visible = false
  container.add(root, proxy.group)
  const after = worldBox(proxy.group)
  close(after.min.x, before.min.x)
  close(after.min.y, before.min.y)
  close(after.min.z, before.min.z)
  close(after.max.x, before.max.x)
  close(after.max.y, before.max.y)
  close(after.max.z, before.max.z)
})

test('преобразование родителя запекается в вершины', () => {
  const root = buildModel(4)
  root.position.set(10, 5, -3)
  root.rotation.y = Math.PI / 3
  root.scale.setScalar(2)
  root.updateMatrixWorld(true)
  const before = worldBox(root)

  const proxy = buildRenderProxy(root)!
  const container = new THREE.Group()
  root.visible = false
  container.add(root, proxy.group)
  const after = worldBox(proxy.group)

  close(after.min.x, before.min.x, 1e-3)
  close(after.max.x, before.max.x, 1e-3)
  close(after.min.y, before.min.y, 1e-3)
  close(after.max.y, before.max.y, 1e-3)
  close(after.min.z, before.min.z, 1e-3)
  close(after.max.z, before.max.z, 1e-3)
})

test('неравномерный масштаб не перекашивает нормали', () => {
  const root = new THREE.Group()
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial(),
  )
  // Плоскость смотрит по +Z; сплющиваем её по Z в 10 раз — при наивном
  // умножении нормаль перестала бы быть единичной и освещение «поплыло» бы.
  mesh.scale.set(1, 1, 0.1)
  root.add(mesh)
  root.updateMatrixWorld(true)

  const proxy = buildRenderProxy(root)!
  const normals = drawnMeshes(proxy.group)[0].geometry.getAttribute('normal')
  for (let i = 0; i < normals.count; i += 1) {
    const length = Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i))
    close(length, 1, 1e-5)
  }
})

test('разные материалы дают разные пачки', () => {
  const root = new THREE.Group()
  for (let i = 0; i < 6; i += 1) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: i % 2 === 0 ? 0xff0000 : 0x00ff00 }),
    )
    mesh.position.x = i
    root.add(mesh)
  }
  root.updateMatrixWorld(true)
  // Шесть материалов — шесть объектов; общими остаются только одинаковые.
  assert.equal(buildRenderProxy(root)!.batchCount, 6)
})

test('исходные меши остаются на месте и доступны для выбора', () => {
  const root = buildModel(8)
  buildRenderProxy(root)
  const originals = drawnMeshes(root)
  assert.equal(originals.length, 8)
  assert.equal(root.getObjectByName('деталь-5')?.type, 'Mesh')
  // Луч не проверяет видимость, поэтому скрытый корень по-прежнему кликабелен.
  root.visible = false
  const raycaster = new THREE.Raycaster()
  raycaster.set(new THREE.Vector3(10, 10, 0), new THREE.Vector3(0, -1, 0).normalize())
  const hits = raycaster.intersectObject(root, true)
  assert.ok(hits.length > 0, 'луч не попал в невидимую деталь')
  assert.equal(hits[0].object.name, 'деталь-5')
})

test('приглушение и подсветка переключаются на прокси', () => {
  const root = buildModel(10)
  const proxy = buildRenderProxy(root)!
  const batch = drawnMeshes(proxy.group)[0]
  const original = batch.material

  proxy.setGhost(true)
  assert.notEqual(batch.material, original, 'материал не сменился на приглушённый')
  assert.equal((batch.material as THREE.Material).transparent, true)

  proxy.setGhost(false)
  assert.equal(batch.material, original, 'исходный материал не вернулся')

  const target = root.getObjectByName('деталь-3') as THREE.Mesh
  proxy.setHighlight(target)
  const highlighted = drawnMeshes(proxy.group).find((m) => m.name === 'highlight')
  assert.ok(highlighted, 'подсветка не появилась')
  // Геометрия общая с оригиналом — подсветка не копирует данные.
  assert.equal(highlighted!.geometry, target.geometry)

  proxy.setHighlight(null)
  assert.equal(
    drawnMeshes(proxy.group).find((m) => m.name === 'highlight'),
    undefined,
    'подсветка не снялась',
  )
})

test('повторная подсветка не плодит меши', () => {
  const root = buildModel(5)
  const proxy = buildRenderProxy(root)!
  for (const name of ['деталь-0', 'деталь-1', 'деталь-2']) {
    proxy.setHighlight(root.getObjectByName(name) as THREE.Mesh)
  }
  assert.equal(drawnMeshes(proxy.group).filter((m) => m.name === 'highlight').length, 1)
})

test('пустая модель не создаёт прокси', () => {
  assert.equal(buildRenderProxy(new THREE.Group()), null)
})

test('меш с массивом материалов не сливается, но рисуется', () => {
  const root = new THREE.Group()
  const multi = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [
    new THREE.MeshStandardMaterial(),
    new THREE.MeshStandardMaterial(),
  ])
  multi.name = 'многоматериальный'
  root.add(multi, ...drawnMeshes(buildModel(3)))
  root.updateMatrixWorld(true)

  const proxy = buildRenderProxy(root)!
  const drawn = drawnMeshes(proxy.group)
  // Одна пачка на три одноматериальных куба плюс копия многоматериального.
  assert.equal(drawn.length, 2)
  assert.ok(drawn.some((m) => Array.isArray(m.material)))
})

test('бюджет вершин разбивает крупную модель на несколько пачек', () => {
  // Сфера с большим числом сегментов быстро выбирает бюджет в 262 144 вершины.
  const material = new THREE.MeshStandardMaterial()
  const root = new THREE.Group()
  for (let i = 0; i < 6; i += 1) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 220, 220), material)
    mesh.position.x = i * 3
    root.add(mesh)
  }
  root.updateMatrixWorld(true)
  const proxy = buildRenderProxy(root)!
  assert.ok(proxy.batchCount > 1, 'модель не разбилась по бюджету вершин')
  for (const batch of drawnMeshes(proxy.group)) {
    assert.ok(
      batch.geometry.getAttribute('position').count <= 262_144,
      'пачка превысила бюджет вершин',
    )
  }
})

test('освобождение прокси не трогает геометрию оригиналов', () => {
  const root = buildModel(6)
  const proxy = buildRenderProxy(root)!
  proxy.dispose()
  for (const mesh of drawnMeshes(root)) {
    assert.ok(mesh.geometry.getAttribute('position'), 'геометрия оригинала пропала')
  }
  assert.equal(proxy.group.children.length, 0)
})

console.log(`\nПройдено: ${passed}, провалено: ${failed}`)
if (failed > 0) process.exit(1)
