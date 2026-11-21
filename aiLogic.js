// === Глобальные переменные, необходимые для оставшихся функций ===
let failedClusters = []; // Массив неудачных точек для построек
const DEFENSE_RADIUS = 200;
// === 1. Проверки и пререквизиты ===
function hasBuilding(buildingType, owner) {
  const found = gameState.buildings.some(b => b.owner === owner && b.type === buildingType);
  return found;
}
const buildingPrerequisites = {
  "base2": ["barracks"],
  "barracks2": ["base2"],
  "turret2": ["base2"],
  "base3": ["barracks2"],
  "barracks3": ["base3"]
};
function canBuild(buildingType) {
  const prereqs = buildingPrerequisites[buildingType];
  if (!prereqs) return true;
  for (const prereq of prereqs) {
    if (!hasBuilding(prereq, "ai")) {
      return false;
    }
  }
  return true;
}
function onDamage(entity, damage, source = null) {
  // 1. Базовая защита от мертвых целей или отрицательного урона
  if (!entity || entity.health <= 0 || damage <= 0) return;

  // 2. Логирование для старого "neural" режима (если он еще используется)
  if (gameMode === "neural" && entity.owner === "ai") {
    if (typeof recentThreats !== "undefined") {
      recentThreats.push({
        x: entity.x,
        y: entity.y,
        timestamp: Date.now(),
        type: "attack",
        severity: damage
      });
    }
  }

  // 3. 🔥 ХУК ДЛЯ GNN: Сообщаем нейросети о полученном уроне (КРИТИЧНО ДЛЯ ОБУЧЕНИЯ!)
  // Это позволит evaluateMissions в gnnAI.js рассчитать награду/штраф за миссию
  if (gameMode === "gnn" && typeof window.GnnEventHooks !== "undefined") {
    window.GnnEventHooks.onUnitDamaged(entity, damage, source);
  }

  // 4. Вычитаем здоровье
  entity.health -= damage;

  // 5. 🔥 БЛОКИРУЕМ хардкод-реакцию для GNN! 
  // Старый ИИ реагирует мгновенно, а GNN должен научиться делать это сам через действия "defend" или "tactic_defend"
  if (gameMode !== "gnn" && typeof reactToAttack === "function") {
    reactToAttack();
  }

  // 6. Обработка смерти
  if (entity.health <= 0) {
    if (entity instanceof Building) {
      if (typeof onBuildingDestroyed === "function") onBuildingDestroyed(entity);
    } else if (entity instanceof Unit) {
      if (gameMode === "pvp") {
        if (entity.owner === playerId) {
          if (typeof sendPvpAction === "function") sendPvpAction({ type: "die", unitId: entity.id });
          if (typeof spawnDestructionFragments === "function") spawnDestructionFragments(entity.x, entity.y, entity.width || 10, entity.height || 10, entity.type);
          if (typeof removeUnit === "function") removeUnit(entity, source); // Передаем source (убийцу)
        }
        // В PvP чужих юнитов локально не удаляем (ждем синхронизации с сервером)
      } else {
        // В одиночной игре — сразу удаляем
        if (typeof spawnDestructionFragments === "function") spawnDestructionFragments(entity.x, entity.y, entity.width || 10, entity.height || 10, entity.type);
        if (typeof removeUnit === "function") removeUnit(entity, source); // Передаем source (убийцу)
      }
    }
  }
}
// === 2. Управление очередью построек ===
function processBuildQueue() {
  const now = performance.now();
  for (let i = 0; i < buildQueue.length; i++) {
    const item = buildQueue[i];
    if (now - item.plannedAt >= item.delay) {
      if (typeof aiPlaceBuilding === "function") {
        const built = aiPlaceBuilding(item.type, item.x, item.y);
        if (built) {
          buildQueue.splice(i, 1);
          i--;
        }
      }
    }
  }
}
function markConstructionFailure(x, y) {
  failedClusters.push({ x, y, timestamp: performance.now() });
}
function cleanupFailedClusters() {
  const timeout = 30000; // 30 секунд
  const now = performance.now();
  failedClusters = failedClusters.filter(pt => (now - pt.timestamp) < timeout);
}
// === 3. Поиск валидной позиции (зависимость для scheduleAIBuilding) ===
function findValidBuildPositionNear(desiredX, desiredY, buildingType, maxAttempts = 20) {
  const buildingDimensions = {
    warehouse: { w: 10, h: 10 }, repairWorkshop: { w: 10, h: 10 },
    barracks: { w: 15, h: 15 }, barracks2: { w: 15, h: 15 }, barracks3: { w: 15, h: 15 },
    turret: { w: 12, h: 12 }, turret2: { w: 15, h: 17 }, turret3: { w: 14, h: 15 },
    beacon: { w: 20, h: 20 }, base2: { w: 25, h: 30 }, base3: { w: 30, h: 30 }
  };
  
  const dims = buildingDimensions[buildingType] || { w: 20, h: 20 };
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const angle = (attempt / maxAttempts) * Math.PI * 2 + Math.random() * 0.5;
    const radius = 30 + attempt * 15; 
    
    const x = desiredX + Math.cos(angle) * radius;
    const y = desiredY + Math.sin(angle) * radius;
    
    if (x < 50 || x > worldWidth - 50 || y < 50 || y > worldHeight - 50) continue;
    if (!isValidAiBuildLocation(x, y)) continue;
    
    const newRect = {
      left: x - dims.w / 2 - 5, top: y - dims.h / 2 - 5,
      right: x + dims.w / 2 + 5, bottom: y + dims.h / 2 + 5
    };
    
    let hasCollision = false;
    for (let b of gameState.buildings) {
      const bRect = {
        left: b.x - b.width / 2 - 5, top: b.y - b.height / 2 - 5,
        right: b.x + b.width / 2 + 5, bottom: b.y + b.height / 2 + 5
      };
      if (typeof rectsOverlap === "function" && rectsOverlap(newRect, bRect)) {
        hasCollision = true;
        break;
      }
    }
    if (!hasCollision) return { x, y };
  }
  return null;
}
// === 4. Планирование и размещение построек (Вызывается GnnAI) ===
function scheduleAIBuilding(type, x, y, delay = 2000) {
  cleanupFailedClusters();
  
  if (failedClusters.some(pt => Math.hypot(pt.x - x, pt.y - y) < 10)) return;
  
  if (!isValidAiBuildLocation(x, y)) {
    const validPos = findValidBuildPositionNear(x, y, type, 15);
    if (validPos) {
      x = validPos.x;
      y = validPos.y;
    } else {
      markConstructionFailure(x, y);
      return;
    }
  }
  
  buildQueue.push({ type, x, y, plannedAt: performance.now(), delay });
}
function aiPlaceBuilding(buildingType, x, y) {
  x = Math.max(0, Math.min(worldWidth, x));
  y = Math.max(0, Math.min(worldHeight, y));

  if (!isValidAiBuildLocation(x, y)) {
    if (typeof markConstructionFailure === "function") markConstructionFailure(x, y);
    return false;
  }

  const dims = {
    warehouse: [10, 10], repairWorkshop: [10, 10],
    barracks: [15, 15], barracks2: [25, 15], barracks3: [20, 15],
    turret: [12, 12], turret2: [15, 17], turret3: [14, 15],
    beacon: [20, 20], base2: [25, 30], base3: [30, 30]
  };
  
  if (!dims[buildingType] || typeof buildingCosts === "undefined" || !buildingCosts[buildingType]) return false;
  const cost = buildingCosts[buildingType];
  const bw = dims[buildingType][0], bh = dims[buildingType][1];

  const newRect = { left: x - bw / 2, top: y - bh / 2, right: x + bw / 2, bottom: y + bh / 2 };
  for (const b of gameState.buildings) {
    const bRect = {
      left: b.x - b.width / 2 - 5, top: b.y - b.height / 2 - 5,
      right: b.x + b.width / 2 + 5, bottom: b.y + b.height / 2 + 5
    };
    if (typeof rectsOverlap === "function" && rectsOverlap(newRect, bRect)) return false;
  }

  if (!canSpendResources(cost, "ai")) return false;

  gameState.aiResources.gold -= cost.gold || 0;
  gameState.aiResources.silicon -= cost.silicon || 0;
  gameState.aiResources.plasma -= cost.plasma || 0;
  if (typeof updateResourceUI === "function") updateResourceUI();

  const building = new Building(buildingType, "ai", x, y);
  building.active = false;
  building.builtAt = performance.now();
  gameState.buildings.push(building);

  // 🔥 НОВОЕ: Выталкиваем камни
  if (typeof pushRocksOutOfBuilding === "function") {
    pushRocksOutOfBuilding(building, 25);
  }

  return building;
}
// === 5. Найм рабочих (Вызывается GnnAI) ===
function aiHireWorker(building) {
  if (!building || building.type !== "warehouse" || !building.active) return;
  if (building.workers >= building.maxDeliveryWorkers) return;
  if (!canSpendResources(WORKER_COST, "ai")) return;

  gameState.aiResources.gold -= WORKER_COST.gold;
  gameState.aiResources.silicon -= WORKER_COST.silicon;
  gameState.aiResources.plasma -= WORKER_COST.plasma;
  if (typeof updateResourceUI === "function") updateResourceUI();

  building.workers++;
  const { spawn, target } = typeof spawnAtBoundary === "function" ? spawnAtBoundary(building, 10) : { spawn: {x: building.x, y: building.y}, target: {x: building.x, y: building.y} };
  
  const worker = typeof getUnitFromPool === "function" ? getUnitFromPool("worker", "ai", spawn.x, spawn.y) : { type: "worker", owner: "ai", x: spawn.x, y: spawn.y };
  worker.homeWarehouse = building;
  worker.carrying = 0; worker.delivering = false;

  if (typeof addUnit === "function") addUnit(worker);
  if (typeof moveUnit === "function") {
    moveUnit(worker, target.x, target.y, () => {
      if (typeof startWorkerCycle === "function") startWorkerCycle(worker, building);
    });
  }
}
// === 6. Найм мастеров (Вызывается GnnAI) ===
function aiHireRepairMan(repairWorkshop) {
  if (!repairWorkshop.active || repairWorkshop.repairman >= repairWorkshop.capacity) return;
  if (!canSpendResources(REPAIRMAN_COST, "ai")) return;

  gameState.aiResources.gold -= REPAIRMAN_COST.gold;
  gameState.aiResources.silicon -= REPAIRMAN_COST.silicon;
  gameState.aiResources.plasma -= REPAIRMAN_COST.plasma;
  if (typeof updateResourceUI === "function") updateResourceUI();

  repairWorkshop.repairman++;
  const { spawn, target } = typeof spawnAtBoundary === "function" ? spawnAtBoundary(repairWorkshop, 10) : { spawn: {x: repairWorkshop.x, y: repairWorkshop.y}, target: {x: repairWorkshop.x, y: repairWorkshop.y} };
  
  const repairman = typeof getUnitFromPool === "function" ? getUnitFromPool("repairman", "ai", spawn.x, spawn.y) : { type: "repairman", owner: "ai", x: spawn.x, y: spawn.y };
  repairman.homeWorkshop = repairWorkshop;

  if (typeof addUnit === "function") addUnit(repairman);
  if (typeof moveUnit === "function") {
    moveUnit(repairman, target.x, target.y, () => {
      if (typeof startRepairmanCycle === "function") startRepairmanCycle(repairman);
    });
  }
}
// === 7. Экономика и производство (Вызывается GnnAI) ===
function canSpendResources(cost, owner) {
  // Fallback на прямое чтение, если глобальная функция getResourcesByOwner отсутствует
  const resources = typeof getResourcesByOwner === "function" 
    ? getResourcesByOwner(owner) 
    : (owner === "ai" ? gameState.aiResources : gameState.playerResources);
  
  return (
    (resources.gold || 0) >= (cost.gold || 0) &&
    (resources.silicon || 0) >= (cost.silicon || 0) &&
    (resources.plasma || 0) >= (cost.plasma || 0)
  );
}
function aiEnqueueMilitaryUnit(unitType, building) {
  if (!building.active) return false;

  let productionTime;
  switch(unitType) {
    case "fighter": productionTime = 6000; break;
    case "assault": productionTime = 12000; break;
    case "elite": productionTime = 25000; break;
    default: return false;
  }
  
  if (!building.productionQueue) building.productionQueue = [];
  if (building.productionQueue.length >= building.productionLimit) return false;
  
  const lastOrder = building.productionQueue[building.productionQueue.length - 1];
  let timeStart = performance.now();
  if (lastOrder) timeStart = lastOrder.timeStart + lastOrder.productionTime;
  
  building.productionQueue.push({ unitType, timeStart, productionTime });
  return true;
}
