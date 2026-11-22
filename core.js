let isPaused = false;
let lastTime = performance.now();
let rockBuildingAuditTimer = 0;
let gameLoopId;
let frameCounter = 0;
const frameSkipMobile = 2;
let swarmFrameCounter = 0;
let particleUpdateAccumulator = 0;
let idCollisionCount = 0;
// 🗺️ A* PATHFINDING (Оптимизированный для RTS)
const PATH_GRID_SIZE = 60; // Размер клетки сетки (чем больше, тем быстрее, но менее точно)
let pathGrid = [];
let gridCols = 0;
let gridRows = 0;
let lastGridUpdate = 0;
let fogUpdateTimer = 0;
const FOG_UPDATE_INTERVAL = 0.15; // Обновлять каждые 0.15 секунды (примерно 6-7 раз в сек)
const GRID_UPDATE_COOLDOWN = 1000; // Обновлять сетку не чаще раза в секунду
const PARTICLE_UPDATE_INTERVAL = 0.033;
const unitGroups = { group1: [], group2: [], group3: [] };
// 🧱 ФУНДАМЕНТ ФИКСОВ — состояние и хелперы
const FX_MIL = ["fighter", "assault", "elite"];
const FX_STATE = {
  frame: 0,
  stats: { phantom: 0, ghost: 0, zombie: 0, dupPool: 0, dupAdd: 0, doubleRemove: 0, culled: 0, mg: 0, rockets: 0 },
  _bs: new Set(), _us: new Set(), _ts: -1e9
};
// Продажа зданий / очередь продаж ИИ
window.aiSaleQueue = window.aiSaleQueue || [];
window.aiSaleCooldown = window.aiSaleCooldown || false;
window.soldBuildings = window.soldBuildings || [];
window.GnnEventHooks = {
  onUnitDamaged: function(unit, damage, source) {
    if (!unit || !unit.missionLog) return;
    unit.missionLog.damageTaken += damage;
    unit.missionLog.events.push({
      t: performance.now() - unit.missionLog.startTime,
      type: "damage_taken",
      amount: damage,
      from: source ? { type: source.type, owner: source.owner, id: source.id } : { type: "area_effect" },
      pos: { x: unit.x, y: unit.y },
      hpAfter: unit.health
    });
    if (source && source.type && source.type.startsWith("turret")) unit.missionLog.hitByTurret = true;
  },
  onUnitDealtDamage: function(unit, damage, target) {
    if (!unit || !unit.missionLog) return;
    if (target && target.id === unit.missionLog.targetId) {
      unit.missionLog.damageDealt += damage;
    }
    unit.missionLog.events.push({
      t: performance.now(),
      type: "damage_dealt",
      amount: damage,
      to: target ? { id: target.id, type: target.type, owner: target.owner } : null,
      isPrimaryTarget: target && target.id === unit.missionLog.targetId
    });
  },
	
  onUnitDeath: function(unit, killer) {
    if (!unit || !unit.missionLog) return;
    unit.missionLog.alive = false;
    unit.missionLog.deathPos = { x: unit.x, y: unit.y };
    unit.missionLog.killedBy = killer ? { type: killer.type, owner: killer.owner, id: killer.id } : null;
    unit.missionLog.events.push({
      t: performance.now() - unit.missionLog.startTime,
      type: "death",
      pos: unit.missionLog.deathPos,
      killedBy: unit.missionLog.killedBy,
      hpAtDeath: 0
    });
  },
  onUnitReachedTarget: function(unit, target) {
    if (!unit || !unit.missionLog) return;
    if (target && target.id === unit.missionLog.targetId) {
      unit.missionLog.reachedTarget = true;
      unit.missionLog.events.push({
        t: performance.now() - unit.missionLog.startTime,
        type: "reached_target",
        targetPos: { x: target.x, y: target.y },
        targetHP: target.health
      });
    }
  }
};
function fxNum(v, d) { return (typeof v === "number" && isFinite(v)) ? v : d; }
function fxClamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function fxInvalidate() { FX_STATE._ts = -1e9; }
function fxSets() {
  const t = performance.now();
  if (t - FX_STATE._ts > 100) {
    FX_STATE._bs = new Set(gameState.buildings);
    FX_STATE._us = new Set(gameState.units);
    FX_STATE._ts = t;
  }
}
function fxInGame(o) { fxSets(); return FX_STATE._bs.has(o) || FX_STATE._us.has(o); }
function fxValidTarget(t) {
  if (!t) return false;
  
  // 🔥 НОВОЕ: Если это ресурс (камень), проверяем hp > 0
  if (t.amount !== undefined) {
    return (t.hp || 0) > 0 && !t.destroyed;
  }
  
  // Стандартная проверка для юнитов/зданий
  if (!(fxNum(t.health, 0) > 0)) return false;
  if (t.destroyed || t.isSelling) return false;
  return true;
}
function fxBaseFor(owner) {
  const ok = b => b && b.health > 0 && fxInGame(b);
  if (owner === "player" && typeof playerBase !== "undefined" && ok(playerBase)) return playerBase;
  if (owner === "ai" && typeof aiBase !== "undefined" && ok(aiBase)) return aiBase;
  return gameState.buildings.find(b => b.owner === owner && b.health > 0 &&
    (String(b.type).startsWith("base") || b.type === "warehouse")) || null;
}
function fxResetTransient(u) {
  if (!u) return;
  
  u.__epoch = (u.__epoch || 0) + 1; 
  u.__phaseInit = false; 
  u.__physFrame = -1; 
  u.__eliteFrame = -1;  
  u.isRetreating = false; 
  u.delivering = false;
  u.suspendedQueue = null; 
  u.moveTarget = null; 
  u.moveCallback = null; 
  u.commandQueue = []; 
  u.target = null; 
  u.isDashing = false; 
  u.carrying = 0;
  u.retreatTarget = null; 
  u.returnToBattleCooldown = 0; 
  u.dashEndTime = 0; 
  u.postDashTimer = 0; 
  u.dashVector = { x: 0, y: 0 }; 
  u.assignedResource = null;
  u.lastAutonomousActionTime = 0; 
  u.lastBurnTick = 0; 
  u.lastShockEffect = 0; 
  u.__fragmentsSpawned = false; 
  u.assignedResourceType = null;
  u.sparkTimer = 0; 
  u.isRepairing = false; 
  u.busyRepair = false; 
  u.__repairTarget = null; 
  u.carriedResourceToken = null;
  
  // 🔥 ШАГ 1.3: НЕ ТРОГАЕМ u.missionLog = null! 
  // Мы хотим сохранить историю миссии юнита до его смерти.
  // Если нужно сбросить статистику для нового юнита из пула, делаем это аккуратно:
  if (u.missionLog) {
    u.missionLog.damageTaken = 0;
    u.missionLog.damageDealt = 0;
    u.missionLog.events = [];
    u.missionLog.alive = true;
    u.missionLog.startTime = performance.now();
    u.missionLog.targetId = null;
    u.missionLog.reachedTarget = false;
    u.missionLog.deathPos = null;
    u.missionLog.killedBy = null;
    u.missionLog.hitByTurret = false;
  }

  u.shockedUntil = 0; 
  u.shocked = false; 
  u.burning = false; 
  u.burnTime = 0; 
  u.burnStartTime = 0; 
  u.burnDuration = 0; 
  u.vx = 0; 
  u.vy = 0;
  u.hidden = false; 
  u.hiding = false; 
  u.inWorkshop = null; 
  u.laserBeam = null;
  
  if (u.repairIntervalId) { clearInterval(u.repairIntervalId); u.repairIntervalId = null; }
  if (u.burningIntervalId) { clearInterval(u.burningIntervalId); u.burningIntervalId = null; }
  if (u.currentMovementAnimation) { cancelAnimationFrame(u.currentMovementAnimation); u.currentMovementAnimation = null; }
  if (u.waitingAnimation) { cancelAnimationFrame(u.waitingAnimation); u.waitingAnimation = null; }
  if (u.__cycleId) { cancelAnimationFrame(u.__cycleId); u.__cycleId = null; }
  if (u.__repairCycleId) { cancelAnimationFrame(u.__repairCycleId); u.__repairCycleId = null; }
}
function fxEnsureCombat(u) {
  if (!u) return;
  u.vx = fxNum(u.vx, 0); u.vy = fxNum(u.vy, 0);
  u.angle = fxNum(u.angle, 0); u.scale = fxNum(u.scale, 1);
  u.lastFireTime = fxNum(u.lastFireTime, 0);
  if (u.strafeDirection !== 1 && u.strafeDirection !== -1) u.strafeDirection = Math.random() < .5 ? -1 : 1;
  if (u.orbitDirection !== 1 && u.orbitDirection !== -1) u.orbitDirection = Math.random() < .5 ? -1 : 1;
  u.strafeTimer = fxNum(u.strafeTimer, Math.random() * 2000 + 800);
  u.orbitPhase = fxNum(u.orbitPhase, Math.random() * Math.PI * 2);
  u.postDashTimer = fxNum(u.postDashTimer, 0);
  u.isDashing = !!u.isDashing;
  u.dashEndTime = fxNum(u.dashEndTime, 0);
  if (!u.dashVector) u.dashVector = { x: 0, y: 0 };

  if (u.type === "fighter") {
    u.range = fxNum(u.range, 180); u.fireRate = fxNum(u.fireRate, 350);
    u.dashTimer = fxNum(u.dashTimer, Math.random() * 4000 + 4000);
  }
  if (u.type === "assault") {
    u.machineGunRange = fxNum(u.machineGunRange, 200);
    u.machineGunFireRate = fxNum(u.machineGunFireRate, 250);
    u.rocketRange = fxNum(u.rocketRange, 280);
    u.range = fxNum(u.range, 280);
    u.lastMachineGunFireTime = fxNum(u.lastMachineGunFireTime, 0);
    u.lastRocketFireTime = fxNum(u.lastRocketFireTime, 0);
    u.figure8Phase = fxNum(u.figure8Phase, Math.random() * Math.PI * 2);
    u.rocketBurstCount = fxNum(u.rocketBurstCount, 0);
    u.rocketBurstTimer = fxNum(u.rocketBurstTimer, 0);
    if (!u.__phaseInit) {
      u.combatPhase = "approach";
      u.phaseTimer = 2500 + Math.random() * 1500;
      u.__phaseInit = true;
      u.__lastShotAt = performance.now();
    } else {
      u.phaseTimer = fxNum(u.phaseTimer, 2000);
      if (u.combatPhase !== "approach" && u.combatPhase !== "retreat") u.combatPhase = "approach";
      u.__lastShotAt = fxNum(u.__lastShotAt, performance.now());
    }
  }
  if (u.type === "elite") {
    u.range = fxNum(u.range, 500);
    u.meleeRange = fxNum(u.meleeRange, 200);
    u.artilleryRange = fxNum(u.artilleryRange, 500);
    u.laserRange = fxNum(u.laserRange, 300);
    u.meleeCooldown = fxNum(u.meleeCooldown, 1000);
    u.artilleryCooldown = fxNum(u.artilleryCooldown, 10000);
    u.laserCooldown = fxNum(u.laserCooldown, 5000);
    u.lastMeleeAttack = fxNum(u.lastMeleeAttack, 0);
    u.lastArtilleryAttack = fxNum(u.lastArtilleryAttack, 0);
    u.lastLaserAttack = fxNum(u.lastLaserAttack, 0);
    u.dashTimer = fxNum(u.dashTimer, 1e9);
  }
}
function fxSanitizeOrders(u) {
  if (!u) return;
  if (u.target && !fxValidTarget(u.target)) { u.target = null; FX_STATE.stats.ghost++; }
  if (Array.isArray(u.commandQueue) && u.commandQueue.length) {
    const n = u.commandQueue.length;
    u.commandQueue = u.commandQueue.filter(c => {
      if (!c) return false;
      if (c.type === "attack") return fxValidTarget(c.target);
      if (c.type === "gather") return c.resource && c.resource.amount > 0 && !c.resource.depleted;
      if (c.type === "repair") return c.target && c.target.health > 0 && c.target.health < c.target.maxHealth;
      if (c.type === "move") return isFinite(c.x) && isFinite(c.y);
      return true;
    });
    if (u.commandQueue.length !== n) FX_STATE.stats.phantom++;
  }
  if (Array.isArray(u.suspendedQueue) && u.suspendedQueue.length) {
    u.suspendedQueue = u.suspendedQueue.filter(c => c &&
      (c.type !== "attack" || fxValidTarget(c.target)) &&
      (c.type !== "gather" || (c.resource && c.resource.amount > 0)));
    if (!u.suspendedQueue.length) u.suspendedQueue = null;
  }
  if (u.type === "repairman" && u.busyRepair && !u.repairIntervalId && !u.moveTarget &&
      !(u.commandQueue || []).some(c => c.type === "repair")) u.busyRepair = false;
}
function cleanUpBuildingReferences() {
  if (typeof quadtree !== 'undefined' && quadtree !== null) {
    quadtree.clear();
    gameState.buildings.forEach(b => quadtree.insert(b));
    gameState.units.forEach(u => quadtree.insert(u));
    gameState.resources.forEach(r => quadtree.insert(r));
  }
}
function spawnDestructionFragments(x, y, width, height, unitType) {
  const color = (typeof unitType === "string" && unitType.startsWith("#")) ? unitType : (fragmentColors[unitType] || "gray");
  const numFragments = Math.floor(Math.random() * 4) + 4;
  const avgRadius = (width + height) / 6;
  for (let i = 0; i < numFragments; i++) {
    const fragment = getFragment();
    fragment.x = x; fragment.y = y;
    fragment.vx = (Math.random() - 0.5) * 100; fragment.vy = (Math.random() - 0.5) * 100;
    fragment.angle = Math.random() * Math.PI * 4; fragment.angularVelocity = (Math.random() - 1) * 4;
    fragment.life = fragment.maxLife = 3 + Math.random() * 2; fragment.color = color;
    const numVertices = Math.floor(Math.random() * 4) + 4;
    const points = [];
    for (let j = 0; j < numVertices; j++) {
      const baseAngle = (j / numVertices) * 2 * Math.PI;
      const angleOffset = (Math.random() - 0.5) * (Math.PI / numVertices);
      const angle = baseAngle + angleOffset;
      const radius = avgRadius * (0.7 + Math.random() * 0.6);
      points.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    }
    fragment.points = points;
    gameState.fragments.push(fragment);
  }
}
function fireBullet(shooter, enemy) {
  if (!shooter || shooter.health <= 0) return;
  if (enemy && isLineOfSightBlocked(shooter.x, shooter.y, enemy.x, enemy.y)) return;
  let bulletConfig, bulletType = 'regular';

  // 🔥 ИСПРАВЛЕНИЕ: Строгий порядок проверок!
  // Сначала проверяем ТУРЕЛИ (они имеют приоритет)
  if (shooter.type === "turret") {
    bulletConfig = TURRET_BULLET_CONFIG;
  } 
  else if (shooter.type === "turret2") {
    bulletConfig = MISSILE_CONFIG;
    bulletType = 'missile';
  } 
  else if (shooter.type === "turret3") {
    bulletConfig = TURRET_LASER_CONFIG;
    // Для лазерной турели не создаем обычную пулю, она стреляет через fireLaserShot
    return; 
  }
  // Потом проверяем ЮНИТОВ
  else if (shooter.type === "fighter") {
    bulletConfig = FIGHTER_BULLET_CONFIG;
  }
  else if (shooter.type === "assault") {
    // Штурмовик стреляет через dynamicAttackAssault, не через fireBullet!
    bulletConfig = FIGHTER_BULLET_CONFIG; // Используем конфигурацию файтера для пулемета
  }
  else if (shooter.type === "elite") {
    // Элита стреляет через dynamicAttackElite, не через fireBullet!
    bulletConfig = MELEE_BULLET_CONFIG;
  }
  else {
    bulletConfig = { speed: 300, lifetime: 1.5, damage: 10 };
  }
  
const bullet = getBulletFromPool(bulletType, shooter, enemy, bulletConfig);
// 🔥 ЯВНЫЙ СБРОС ЦВЕТА И ВСЕХ ФЛАГОВ ПЕРЕД УСТАНОВКОЙ НОВОГО
bullet.color = null;
bullet.isArtillery = false;
bullet.isMelee = false;
bullet.isMissile = (bulletType === 'missile');
bullet.alive = true;
bullet.shooter = shooter;
bullet.target = enemy;
bullet.x = shooter.x;
bullet.y = shooter.y;
bullet.angle = Math.atan2(enemy.y - shooter.y, enemy.x - shooter.x);
bullet.speed = bulletConfig.speed;
bullet.lifetime = bulletConfig.lifetime;
const isUnitShooter = ["fighter", "assault", "elite"].includes(shooter.type);
bullet.damage = (isUnitShooter && shooter.damage > 0) ? shooter.damage : bulletConfig.damage;
if (bullet.isMissile) {
bullet.splashRadius = MISSILE_CONFIG.splashRadius;
bullet.splashDamage = MISSILE_CONFIG.splashDamage;
} else {
bullet.splashRadius = 0;
bullet.splashDamage = 0;
}

  // Цвета для визуального различия
  if (shooter.type === "assault") {
    bullet.color = "128,0,128"; // Фиолетовый для штурмовика
  } else if (shooter.type === "elite") {
    bullet.color = "255,165,0"; // Оранжевый для элиты
  }
  
  if (gameMode === "pvp" && (shooter.type === "turret" || shooter.type === "turret2") && shooter.owner === playerId) {
    sendPvpAction({
      type: "turretFire",
      turretId: shooter.id,
      turretType: shooter.type,
      targetId: enemy.id
    });
  }

  gameState.bullets.push(bullet);
}
// 1. Построение сетки препятствий
function updatePathfindingGrid() {
  const now = performance.now();
  if (now - lastGridUpdate < GRID_UPDATE_COOLDOWN) return;
  lastGridUpdate = now;

  gridCols = Math.ceil(worldWidth / PATH_GRID_SIZE);
  gridRows = Math.ceil(worldHeight / PATH_GRID_SIZE);
  pathGrid = new Array(gridCols * gridRows).fill(0); // 0 = свободно, 1 = занято

  // Помечаем камни как препятствия (с небольшим запасом, чтобы путь огибал их, а не шел впритык)
  const margin = 35; 
  for (const rock of gameState.resources) {
    if (rock.hp <= 0) continue;
    const r = rock.getCurrentRadius() + margin;
    const minCol = Math.max(0, Math.floor((rock.x - r) / PATH_GRID_SIZE));
    const maxCol = Math.min(gridCols - 1, Math.floor((rock.x + r) / PATH_GRID_SIZE));
    const minRow = Math.max(0, Math.floor((rock.y - r) / PATH_GRID_SIZE));
    const maxRow = Math.min(gridRows - 1, Math.floor((rock.y + r) / PATH_GRID_SIZE));

    for (let c = minCol; c <= maxCol; c++) {
      for (let r_idx = minRow; r_idx <= maxRow; r_idx++) {
        // Проверяем, попадает ли центр клетки в круг камня для большей точности
        const cellX = c * PATH_GRID_SIZE + PATH_GRID_SIZE / 2;
        const cellY = r_idx * PATH_GRID_SIZE + PATH_GRID_SIZE / 2;
        if (Math.hypot(cellX - rock.x, cellY - rock.y) < r) {
          pathGrid[r_idx * gridCols + c] = 1;
        }
      }
    }
  }
}
// 🔥 2: A* Pathfinding с Min-Heap (O(log N) вместо O(N log N))
function findPath(startX, startY, endX, endY) {
  updatePathfindingGrid();

  const startCol = Math.floor(startX / PATH_GRID_SIZE);
  const startRow = Math.floor(startY / PATH_GRID_SIZE);
  const endCol = Math.floor(endX / PATH_GRID_SIZE);
  const endRow = Math.floor(endY / PATH_GRID_SIZE);

  if (startCol === endCol && startRow === endRow) return [];

  // 🔥 ИСПОЛЬЗУЕМ MIN-HEAP ВМЕСТО МАССИВА + SORT
  const openSet = new MinHeap();
  const closedSet = new Uint8Array(gridCols * gridRows);
  const cameFrom = new Int32Array(gridCols * gridRows).fill(-1);
  const gScore = new Float32Array(gridCols * gridRows).fill(Infinity);
  const fScore = new Float32Array(gridCols * gridRows).fill(Infinity);

  const startIndex = startRow * gridCols + startCol;
  gScore[startIndex] = 0;
  fScore[startIndex] = Math.hypot(endX - startX, endY - startY);
  openSet.push({ index: startIndex, f: fScore[startIndex] });

  const directions = [
    { dc: 0, dr: -1 }, { dc: 1, dr: -1 }, { dc: 1, dr: 0 }, { dc: 1, dr: 1 },
    { dc: 0, dr: 1 }, { dc: -1, dr: 1 }, { dc: -1, dr: 0 }, { dc: -1, dr: -1 }
  ];

  let iterations = 0;
  const MAX_ITERATIONS = 500;

  // 🔥 openSet.size вместо openSet.length
  while (openSet.size > 0 && iterations < MAX_ITERATIONS) {
    iterations++;
    
    // 🔥 pop() вместо sort() + shift() — в 10-50 раз быстрее!
    const current = openSet.pop();
    const cRow = Math.floor(current.index / gridCols);
    const cCol = current.index % gridCols;

    if (cCol === endCol && cRow === endRow) {
      const path = [];
      let curr = current.index;
      while (curr !== -1) {
        path.push({
          x: (curr % gridCols) * PATH_GRID_SIZE + PATH_GRID_SIZE / 2,
          y: Math.floor(curr / gridCols) * PATH_GRID_SIZE + PATH_GRID_SIZE / 2
        });
        curr = cameFrom[curr];
      }
      return path.reverse();
    }

    closedSet[current.index] = 1;

    for (const dir of directions) {
      const nCol = cCol + dir.dc;
      const nRow = cRow + dir.dr;

      if (nCol < 0 || nCol >= gridCols || nRow < 0 || nRow >= gridRows) continue;
      
      const nIndex = nRow * gridCols + nCol;
      if (closedSet[nIndex] || pathGrid[nIndex] === 1) continue;

      const isDiagonal = dir.dc !== 0 && dir.dr !== 0;
      const moveCost = isDiagonal ? 1.414 : 1.0;
      const tentativeGScore = gScore[current.index] + moveCost * PATH_GRID_SIZE;

      if (tentativeGScore < gScore[nIndex]) {
        cameFrom[nIndex] = current.index;
        gScore[nIndex] = tentativeGScore;
        const hScore = Math.hypot(endX - (nCol * PATH_GRID_SIZE + PATH_GRID_SIZE / 2), endY - (nRow * PATH_GRID_SIZE + PATH_GRID_SIZE / 2));
        fScore[nIndex] = gScore[nIndex] + hScore;
        
        // 🔥 push() в MinHeap вместо push() в массив
        openSet.push({ index: nIndex, f: fScore[nIndex] });
      }
    }
  }
  
  return [{ x: endX, y: endY }];
}
// Превращает ломаную линию сетки в несколько ключевых точек поворота
function simplifyPath(rawPath) {
  if (rawPath.length <= 2) return rawPath;
  const waypoints = [rawPath[0]];
  let currentDir = { x: rawPath[1].x - rawPath[0].x, y: rawPath[1].y - rawPath[0].y };
  
  for (let i = 2; i < rawPath.length; i++) {
    const nextDir = { x: rawPath[i].x - rawPath[i-1].x, y: rawPath[i].y - rawPath[i-1].y };
    // Если направление изменилось, добавляем точку как waypoint
    if (Math.abs(currentDir.x - nextDir.x) > 0.1 || Math.abs(currentDir.y - nextDir.y) > 0.1) {
      waypoints.push(rawPath[i-1]);
      currentDir = nextDir;
    }
  }
  waypoints.push(rawPath[rawPath.length - 1]);
  return waypoints;
}
function checkVictoryConditions() {
  if (gameState.gameEnded) return;
  if (gameMode === "single") {
    const playerBuildings = gameState.buildings.filter(b => b.owner === "player");
    const aiBuildings = gameState.buildings.filter(b => b.owner === "ai");
    if (aiBuildings.length === 0) { clearInterval(aiLogicInterval); cancelAnimationFrame(gameLoopId); gameState.gameEnded = true; setTimeout(() => showVictoryScreen("Победа! Все здания противника уничтожены."), 3000); return; }
    if (playerBuildings.length === 0) { clearInterval(aiLogicInterval); cancelAnimationFrame(gameLoopId); gameState.gameEnded = true; setTimeout(() => showVictoryScreen("Поражение! Все ваши здания уничтожены."), 3000); return; }
  }
  if (gameMode === "pvp" && performance.now() - pvpStartedAt > 3000) {
    const playerBuildings = gameState.buildings.filter(b => b.owner === playerId);
    const enemyBuildings = gameState.buildings.filter(b => b.owner === opponentId);
    if (enemyBuildings.length === 0) { cancelAnimationFrame(gameLoopId); gameState.gameEnded = true; setTimeout(() => showVictoryScreen("🎉 Ты победил!"), 2000); return; }
    if (playerBuildings.length === 0) { cancelAnimationFrame(gameLoopId); gameState.gameEnded = true; setTimeout(() => showVictoryScreen("💀 Ты проиграл!"), 2000); return; }
  }
}
function initFogOfWar() {
  const cols = Math.ceil(worldWidth / FOG_CELL_SIZE), rows = Math.ceil(worldHeight / FOG_CELL_SIZE);
  fogMap = [];
  for (let r = 0; r < rows; r++) fogMap[r] = new Array(cols).fill(0);
  if (!persistentFogMap || persistentFogMap.length === 0) {
    persistentFogMap = [];
    for (let r = 0; r < rows; r++) persistentFogMap[r] = new Array(cols).fill(0);
  } else {
    for (let r = 0; r < rows; r++) {
      if (r < persistentFogMap.length) {
        while (persistentFogMap[r].length < cols) persistentFogMap[r].push(0);
        persistentFogMap[r] = persistentFogMap[r].slice(0, cols);
      } else { persistentFogMap[r] = new Array(cols).fill(0); }
    }
    persistentFogMap = persistentFogMap.slice(0, rows);
  }
}
function updateFogOfWar() {
  if (!fogMap || !fogMap.length || !fogMap[0]) return;
  const invScale = 1 / camera.scale;
  const viewLeft = -camera.offsetX * invScale;
  const viewTop = -camera.offsetY * invScale;
  const viewRight = viewLeft + canvas.width * invScale;
  const viewBottom = viewTop + canvas.height * invScale;

  // 1. Сброс видимости на экране
  const sCol = Math.max(0, Math.floor(viewLeft / FOG_CELL_SIZE));
  const eCol = Math.min(fogMap[0].length - 1, Math.floor(viewRight / FOG_CELL_SIZE));
  const sRow = Math.max(0, Math.floor(viewTop / FOG_CELL_SIZE));
  const eRow = Math.min(fogMap.length - 1, Math.floor(viewBottom / FOG_CELL_SIZE));
  for (let r = sRow; r <= eRow; r++)
    for (let c = sCol; c <= eCol; c++) fogMap[r][c] = 0;

  // 2. Raycast от источников
  const visionSources = gameState.units
    .filter(u => u.owner === playerId)
    .concat(gameState.buildings.filter(b => b.owner === playerId));

  visionSources.forEach(source => {
    const visionRadius = source.visionRadius || VISION_RADIUS;

    // 🔥 Камни рядом с источником — собираем ОДИН раз на источник
    const nearbyRocks = gameState.resources.filter(r =>
      r.hp > 0 && Math.hypot(r.x - source.x, r.y - source.y) < visionRadius + 40
    );

    const rays = 48; // больше лучей = глаже тени
    const angleStep = (Math.PI * 2) / rays;
    const step = FOG_CELL_SIZE * 0.5;

    for (let i = 0; i < rays; i++) {
      const angle = i * angleStep;
      const dx = Math.cos(angle), dy = Math.sin(angle);

      for (let d = 0; d < visionRadius; d += step) {
        const cx = source.x + dx * d;
        const cy = source.y + dy * d;
        const col = Math.floor(cx / FOG_CELL_SIZE);
        const row = Math.floor(cy / FOG_CELL_SIZE);
        if (row < 0 || row >= fogMap.length || col < 0 || col >= fogMap[0].length) break;

        fogMap[row][col] = 1;
        persistentFogMap[row][col] = 1;

        // 🔥 Луч упёрся в камень — клетка камня ещё видна, дальше ТЕНЬ
        let blocked = false;
        for (const rock of nearbyRocks) {
          const r = rock.getCurrentRadius ? rock.getCurrentRadius() : rock.baseRadius;
          if ((rock.x - cx) * (rock.x - cx) + (rock.y - cy) * (rock.y - cy) < r * r) {
            blocked = true; break;
          }
        }
        if (blocked) break;
      }
    }
  });

  // 3. Разведка-зоны (без LoS — перк «взламывает» туман)
  const now = Date.now();
  reconZones.forEach(zone => {
    if (now > zone.start + zone.duration) return;
    const radius = 80;
    const s = Math.max(0, Math.floor((zone.x - radius) / FOG_CELL_SIZE));
    const e = Math.min(fogMap[0].length - 1, Math.floor((zone.x + radius) / FOG_CELL_SIZE));
    const sr = Math.max(0, Math.floor((zone.y - radius) / FOG_CELL_SIZE));
    const er = Math.min(fogMap.length - 1, Math.floor((zone.y + radius) / FOG_CELL_SIZE));
    for (let r = sr; r <= er; r++)
      for (let c = s; c <= e; c++) {
        const cx = c * FOG_CELL_SIZE + FOG_CELL_SIZE / 2;
        const cy = r * FOG_CELL_SIZE + FOG_CELL_SIZE / 2;
        if (Math.hypot(zone.x - cx, zone.y - cy) <= radius) {
          fogMap[r][c] = 1; persistentFogMap[r][c] = 1;
        }
      }
  });
}
function showVictoryScreen(message) {
  let victoryScreen = document.getElementById("victoryScreen");
  if (!victoryScreen) {
    victoryScreen = document.createElement("div");
    victoryScreen.id = "victoryScreen";
    victoryScreen.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:10002;display:flex;flex-direction:column;justify-content:center;align-items:center;background-color:rgba(0,0,0,0.8);";
    document.body.appendChild(victoryScreen);
  }
  victoryScreen.innerHTML = "";
  const video = document.createElement("video");
  video.autoplay = true; video.muted = true; video.loop = true; video.playsInline = true;
  video.style.cssText = "position:absolute;top:50%;left:50%;transform:translate(-50%, -55%) scale(1.1);min-width:100%;min-height:100%;object-fit:cover;z-index:-1;";
  const source = document.createElement("source");
  source.src = "src/video/background2.mp4"; source.type = "video/mp4";
  video.appendChild(source); victoryScreen.appendChild(video);
  const container = document.createElement("div");
  container.style.cssText = "position:relative;z-index:10;text-align:center;color:#fff;padding:20px;background-color:rgba(0,0,0,0.5);border-radius:10px;";
  const messageElement = document.createElement("h1");
  messageElement.innerText = message; messageElement.style.marginBottom = "20px";
  container.appendChild(messageElement);
  const exitButton = document.createElement("button");
  exitButton.innerText = "Выйти"; exitButton.style.cssText = "margin:0 10px;padding:10px 20px;font-size:16px;cursor:pointer;";
  exitButton.onclick = () => location.reload();
  container.appendChild(exitButton);
  victoryScreen.appendChild(container);
  stopAllIntervals();
}
// 🔥 ЕДИНАЯ ТОЧКА НАНЕСЕНИЯ УРОНА (пули + сплэш)
function fxApplyDamage(entity, damage, source) {
  if (!entity || !(entity.health > 0) || !(damage > 0) || entity.destroyed) return;
  
  if (source) entity.__lastAttacker = source;
  
  // 🔥 ШАГ 2 (КРИТИЧНО): УДАЛЕНО entity.__fragmentsSpawned = true; 
  // Этим флагом должен управлять ТОЛЬКО removeUnit или onBuildingDestroyed в момент реального спавна осколков!
  // Иначе removeUnit думает, что осколки уже были, и пропускает их создание.

  if (typeof onDamage === "function") {
    // 🔥 ШАГ 1.5 (КРИТИЧНО): ПЕРЕДАЕМ source, чтобы GnnEventHooks.onUnitDamaged знал, кто нанес урон!
    onDamage(entity, damage, source); 
  } else {
    entity.health -= damage;
    if (typeof window.GnnEventHooks !== 'undefined') {
      window.GnnEventHooks.onUnitDamaged(entity, damage, source);
    }
  }
  
  // Страховка добивания: если onDamage не убрал труп — убираем сами, ровно один раз
  if (entity.health <= 0 && !entity.__removed) {
    const isBld = (typeof Building !== "undefined" && entity instanceof Building);
    if (isBld) {
      if (gameState.buildings.indexOf(entity) !== -1) { 
        entity.__removed = true; 
        onBuildingDestroyed(entity); 
      }
    } else {
      removeUnit(entity, source || entity.__lastAttacker || null);
    }
  }
}
// ОПТИМИЗИРОВАННЫЙ ГОРЯЧИЙ ЦИКЛ ПУЛЬ ===
function updateBullets(deltaTime) {
  // Обратный цикл позволяет безопасно удалять элементы через splice
  for (let i = gameState.bullets.length - 1; i >= 0; i--) {
    let bullet = gameState.bullets[i];
    
    // 1. Самонаведение ракеты (без создания новых объектов)
    if (bullet.isMissile && bullet.target && bullet.target.health > 0) {
      let desiredAngle = Math.atan2(bullet.target.y - bullet.y, bullet.target.x - bullet.x);
      let angleDiff = desiredAngle - bullet.angle;
      angleDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff));
      bullet.angle += angleDiff * 0.1;
    }
    
    bullet.x += Math.cos(bullet.angle) * bullet.speed * deltaTime;
    bullet.y += Math.sin(bullet.angle) * bullet.speed * deltaTime;
    
    // 2. Быстрая проверка на истечение времени жизни или потерю цели
    if (!bullet.shooter || !bullet.target || bullet.lifetime <= 0) {
      if (bullet.isMissile || bullet.isArtillery) applySplashDamage(bullet);
      releaseBulletToPool(bullet);
      gameState.bullets.splice(i, 1);
      continue;
    }

    // 3. Оптимизированный поиск коллизий через Quadtree
    const range = 15; // Чуть увеличили радиус для надёжного попадания по большим камням
    const queryRect = { x: bullet.x - range, y: bullet.y - range, width: range * 2, height: range * 2 };
    const candidates = quadtree ? quadtree.query(queryRect) : [];
    let hit = false;

    for (let j = 0; j < candidates.length; j++) {
      let target = candidates[j];
      if (!target || target === bullet.shooter) continue;

      // 🔥 НОВАЯ ЛОГИКА: ПРОВЕРКА НА КАМЕНЬ (РЕСУРС)
      // У ресурсов есть свойство amount, у юнитов/зданий его нет
      const isRock = target.amount !== undefined;

      // 🔥 НОВАЯ ЛОГИКА: ПРОВЕРКА НА КАМЕНЬ (РЕСУРС)
      if (isRock && target.hp > 0) {
        const dist = Math.hypot(bullet.x - target.x, bullet.y - target.y);
        const rockRadius = typeof target.getCurrentRadius === "function" ? target.getCurrentRadius() : (target.baseRadius || 20);

        if (dist < rockRadius) {
          hit = true;

          if (bullet.isMissile || bullet.isArtillery) {
            const impulse = bullet.isArtillery ? 15 : 8;
            const damage = bullet.isArtillery ? 8 : 4;

            if (typeof target.applyImpulse === "function") target.applyImpulse(bullet.angle, impulse);
            
            // 🔥 ЗАЩИТА ОТ МУЛЬТИ-ХИТА ЗАЛПА: токен спавнится не чаще раза в 400мс
            const now = performance.now();
            if (!target._lastTokenDrop || now - target._lastTokenDrop > 400) {
              target._lastTokenDrop = now;
              
              if (!gameState.resourceTokens) gameState.resourceTokens = [];
              const tokenCount = 1 + Math.floor(Math.random() * 2); // 1-2 токена за залп (не за снаряд!)
              const dropPerToken = Math.max(1, Math.floor(damage * 2));
              
              for (let i = 0; i < tokenCount; i++) {
                const angle = Math.random() * Math.PI * 2;
                const speed = 40 + Math.random() * 40;
                const spawnDist = rockRadius + 8; // 🔥 за границей камня!
                
                gameState.resourceTokens.push({
                  x: target.x + Math.cos(angle) * spawnDist,
                  y: target.y + Math.sin(angle) * spawnDist,
                  vx: Math.cos(angle) * speed,
                  vy: Math.sin(angle) * speed,
                  type: target.type,
                  amount: dropPerToken,
                  life: 20.0,
                  maxLife: 20.0,
                  isGround: true
                });
              }
            }

            if (typeof target.takeDamage === "function") {
              const isDestroyed = target.takeDamage(damage);
              if (isDestroyed && typeof destroyResource === "function") {
                destroyResource(target);
              }
            }
            spawnSparkEffect(bullet.x, bullet.y);
            if (bullet.splashRadius > 0) applySplashDamage(bullet);
          } else {
            if (typeof target.takeDamage === "function") target.takeDamage(8);
            spawnSparkEffect(bullet.x, bullet.y);
          }
          break;
        }
      }

      // 4. СТАРАЯ ЛОГИКА: ПРОВЕРКА НА ЮНИТОВ И ЗДАНИЯ
      if (target.owner === bullet.shooter.owner || !(target.health > 0) || target.destroyed) continue;
      
      hit = true;
      fxApplyDamage(target, bullet.damage, bullet.shooter); // Урон РОВНО один раз

      if (bullet.isMissile || bullet.isArtillery) {
        applySplashDamage(bullet);
      } else {
        spawnSparkEffect(bullet.x, bullet.y);
      }
      break; // Пуля поражает первую цель (юнит/здание) и исчезает
    }

    // 5. Очистка пули
    if (hit) {
      releaseBulletToPool(bullet);
      gameState.bullets.splice(i, 1);
    } else {
      bullet.lifetime -= deltaTime;
    }
  }
}
function applySplashDamage(bullet) {
if (!bullet || !bullet.shooter || !(bullet.splashRadius > 0)) return;
spawnExplosionEffect(bullet.x, bullet.y);
const queryRect = {
x: bullet.x - bullet.splashRadius,
y: bullet.y - bullet.splashRadius,
width: bullet.splashRadius * 2,
height: bullet.splashRadius * 2
};
const candidates = quadtree ? quadtree.query(queryRect) : [];
const done = new Set();   // 🔥 один объект не может получить сплэш дважды
for (let i = 0; i < candidates.length; i++) {
const obj = candidates[i];
if (!obj || done.has(obj)) continue;
if (obj.owner === bullet.shooter.owner || !(obj.health > 0) || obj.destroyed) continue;
if (Math.hypot(obj.x - bullet.x, obj.y - bullet.y) > bullet.splashRadius) continue;
done.add(obj);
fxApplyDamage(obj, bullet.splashDamage, bullet.shooter);
}
}
function updateParticles(deltaTime) {
  gameState.units.forEach(unit => { if (unit.burning && performance.now() - unit.burnStartTime > unit.burnDuration) unit.burning = false; });
  updateShockZones(deltaTime);
  particleUpdateAccumulator += deltaTime;
  if (particleUpdateAccumulator < PARTICLE_UPDATE_INTERVAL) return;
  for (let i = gameState.particles.length - 1; i >= 0; i--) {
    const p = gameState.particles[i];
    p.life -= particleUpdateAccumulator;
    if (p.life <= 0) { gameState.particles.splice(i, 1); releaseParticle(p); continue; }
    p.x += p.vx * particleUpdateAccumulator; p.y += p.vy * particleUpdateAccumulator;
  }
  particleUpdateAccumulator = 0;
}
function updateFragments(deltaTime) {
  for (let i = gameState.fragments.length - 1; i >= 0; i--) {
    const f = gameState.fragments[i];
    f.life -= deltaTime;
    if (f.life <= 0) { gameState.fragments.splice(i, 1); releaseFragment(f); continue; }
    f.x += f.vx * deltaTime; f.y += f.vy * deltaTime; f.angle += (f.rotationSpeed || 0) * deltaTime;
  }
}
function updateSwarmBehavior(deltaTime) {
  const neighborRadius = 15, separationDistance = 20, cohesionFactor = 0.001, alignmentFactor = 0.1, separationSmoothing = 1;
  gameState.units.forEach(unit => {
    if (unit.commandQueue && unit.commandQueue.length > 0) return;
    if (unit.idlePhase === undefined) unit.idlePhase = Math.random() * Math.PI * 2;
    const currentTime = performance.now() / 1000;
    unit.x += Math.sin(currentTime + unit.idlePhase) * 3 * deltaTime;
    unit.y += Math.cos(currentTime + unit.idlePhase) * 3 * deltaTime;
    unit.scale = 1 + Math.sin(currentTime + unit.idlePhase) * 0.3;
    const queryRectNeighbors = { x: unit.x - neighborRadius, y: unit.y - neighborRadius, width: 2 * neighborRadius, height: 2 * neighborRadius };
    let neighbors = quadtree ? quadtree.query(queryRectNeighbors) : [];
    neighbors = neighbors.filter(other => other !== unit && other.owner === unit.owner && other instanceof Unit && Math.hypot(other.x - unit.x, other.y - unit.y) <= neighborRadius);
    if (neighbors.length > 0) {
      let sumX = 0, sumY = 0, sumAngle = 0;
      neighbors.forEach(other => { sumX += other.x; sumY += other.y; sumAngle += other.angle; });
      const desiredAngle = Math.atan2((sumY / neighbors.length) - unit.y, (sumX / neighbors.length) - unit.x);
      unit.angle = lerpAngle(unit.angle, desiredAngle, cohesionFactor * deltaTime);
      unit.angle = lerpAngle(unit.angle, sumAngle / neighbors.length, alignmentFactor * deltaTime);
    }
    const queryRectSeparation = { x: unit.x - separationDistance, y: unit.y - separationDistance, width: 2 * separationDistance, height: 2 * separationDistance };
    let closeNeighbors = quadtree ? quadtree.query(queryRectSeparation) : [];
    closeNeighbors = closeNeighbors.filter(other => other !== unit && other.owner === unit.owner && other instanceof Unit && Math.hypot(other.x - unit.x, other.y - unit.y) <= separationDistance);
    closeNeighbors.forEach(other => {
      const dx = unit.x - other.x, dy = unit.y - other.y;
      const distance = Math.hypot(dx, dy);
      if (distance < separationDistance && distance > 0) {
        const overlap = separationDistance - distance;
        const adjustment = (overlap * separationSmoothing * deltaTime) / 2;
        const adjustX = (dx / distance) * adjustment, adjustY = (dy / distance) * adjustment;
        unit.x += adjustX; unit.y += adjustY; other.x -= adjustX; other.y -= adjustY;
      }
    });
  });
}
function updateTurret(building) {
  if (!building.active) return;
  const now = performance.now();
  if (building.type === "turret3") {
    if (building.lastUpdateTime === undefined) { building.lastUpdateTime = now; building.charge = 0; }
    const dt = now - building.lastUpdateTime;
    building.lastUpdateTime = now;
    if (building.target) {
      const targetAngle = Math.atan2(building.target.y - building.y, building.target.x - building.x);
      let angleDiff = targetAngle - building.angle;
      angleDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff));
      building.angle += angleDiff * 0.1;
      if (Math.abs(angleDiff) < 0.05) building.charge += 1 * dt;
      if (building.charge >= (building.FIRE_THRESHOLD || 500) && Math.abs(angleDiff) < 0.05 && (now - building.lastFireTime >= building.fireRate)) {
        fireLaserShot(building, building.target); building.lastFireTime = now; building.charge -= (building.FIRE_THRESHOLD || 500);
      }
    } else { building.charge *= 0.99; building.angle += 0.01; }
    return;
  }
  if (building.target) {
    const targetAngle = Math.atan2(building.target.y - building.y, building.target.x - building.x);
    let angleDiff = targetAngle - building.angle;
    angleDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff));
    building.angle += angleDiff * 0.1;
    const dist = Math.hypot(building.target.x - building.x, building.target.y - building.y);
    if (dist > building.range || building.target.health <= 0) { building.target = null; } 
    else if (now - building.lastFireTime > building.fireRate) { fireBullet(building, building.target); building.lastFireTime = now; }
  } else { building.angle += 0.01; }
}
function updateBuildingsActivation() {
  const now = performance.now();
  gameState.buildings.forEach(building => {
    if (!building.active && now - building.builtAt >= building.activationDelay) {
      building.active = true;
      if (["turret", "turret2", "turret3"].includes(building.type)) startTurretCycle(building);
    }
  });
}
function updateCapturePoints() {
  if (!gameState.capturePoints) return;
  gameState.capturePoints.forEach(cp => {
    const unitsInRange = gameState.units.filter(unit => Math.hypot(unit.x - cp.x, unit.y - cp.y) < 50);
    if (unitsInRange.length > 0) {
      let owner = null;
      if (gameMode === "single") {
        const playerCount = unitsInRange.filter(u => u.owner === "player").length;
        const aiCount = unitsInRange.filter(u => u.owner === "ai").length;
        if (playerCount > aiCount) owner = "player"; else if (aiCount > playerCount) owner = "ai";
      } else if (gameMode === "pvp") {
        const grouped = unitsInRange.reduce((acc, u) => { acc[u.owner] = (acc[u.owner] || 0) + 1; return acc; }, {});
        const maxOwner = Object.entries(grouped).reduce((a, b) => a[1] > b[1] ? a : b, [null, 0]);
        if (maxOwner[0] !== cp.owner && maxOwner[1] > 0) owner = maxOwner[0];
      }
      if (owner) {
        cp.owner = owner; cp.color = (owner === playerId) ? "#00FF00" : "#FF0000";
        if (!cp.waveSpawnInterval && !cp.waveSpawnTimeout && gameMode === "single") {
          cp.waveSpawnTimeout = setTimeout(() => {
            spawnWaveFromCapturePoint(cp);
            cp.waveSpawnInterval = setInterval(() => spawnWaveFromCapturePoint(cp), 60000);
            cp.waveSpawnTimeout = null;
          }, 30000);
        }
      }
    }
  });
}
function updateLasers() {
  if (!gameState?.lasers || !Array.isArray(gameState.lasers)) return;
  const now = performance.now();
  
  for (let i = gameState.lasers.length - 1; i >= 0; i--) {
    const laser = gameState.lasers[i];
    if (!laser || !laser.active) continue;

    // 1. Строгая проверка живости
    const isShooterAlive = laser.shooter && laser.shooter.health > 0;
    const isTargetAlive = laser.target && laser.target.health > 0;

    if (!isShooterAlive || !isTargetAlive) {
      laser.active = false;
      continue;
    }

    if (now - laser.lastTick >= laser.tickInterval) {
      const sx = laser.shooter.x, sy = laser.shooter.y;
      const tx = laser.target.x, ty = laser.target.y;
      
      const dx = tx - sx, dy = ty - sy;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len === 0) continue;
      
      const nx = dx / len, ny = dy / len;
      const maxDist = len + 100; // Пробивание на 100 пикселей
      
      const hitTargets = [];
      const allEntities = [...gameState.units, ...gameState.buildings];
      
      allEntities.forEach(entity => {
        // БЕЗОПАСНАЯ ПРОВЕРКА: пропускаем мёртвые или свои цели
        if (!entity || entity.owner === laser.shooter.owner || entity.health <= 0) return;
        
        const ux = entity.x - sx, uy = entity.y - sy;
        const proj = ux * nx + uy * ny;
        
        if (proj < 0 || proj > maxDist) return;
        
        const perpX = ux - nx * proj;
        const perpY = uy - ny * proj;
        const distToLine = Math.sqrt(perpX * perpX + perpY * perpY);
        
        // КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: безопасная проверка вместо instanceof
        const isBuilding = entity.width !== undefined; 
        const hitRadius = isBuilding ? 35 : 25; 
        
        if (distToLine <= hitRadius) {
          hitTargets.push({ entity, dist: proj });
        }
      });
      
      // Сортируем по расстоянию (ближайшие получают урон первыми)
      hitTargets.sort((a, b) => a.dist - b.dist);
      
      // ОТЛАДКА: ты увидишь это в консоли, если лазер попал!
      if (hitTargets.length > 0) {
        //console.log(`[⚡ LASER HIT] Целей поражено: ${hitTargets.length}. Базовый урон: ${laser.damage}`);
      }
      
      hitTargets.forEach((hit, index) => {
        const entity = hit.entity;
        
        // Защита от NaN
        let damage = (typeof laser.damage === 'number' && !isNaN(laser.damage)) ? laser.damage : 50;
        if (index > 0) damage *= Math.pow(0.7, index);
        
        // КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: вызываем onDamage!
        if (typeof onDamage === "function") {
          onDamage(entity, damage);
        } else {
          // Fallback
          entity.health -= damage;
          if (entity.health <= 0) {
            const isBld = entity.width !== undefined;
            if (isBld) {
              if (typeof onBuildingDestroyed === "function") onBuildingDestroyed(entity);
            } else {
              if (typeof removeUnit === "function") removeUnit(entity);
            }
          }
        }
        
        // Визуальные эффекты попадания
        if (typeof applyBurningEffect === "function") applyBurningEffect(entity);
        if (typeof spawnSparkEffect === "function") spawnSparkEffect(entity.x, entity.y);
        
        // Яркая вспышка для первой цели
        if (index === 0) {
          gameState.particles.push({
            x: entity.x, y: entity.y, vx: 0, vy: 0,
            life: 0.15, maxLife: 0.15, radius: 15,
            color: "#FF00FF", flash: true
          });
        }
      }); // <-- КОНЕЦ forEach. Больше никаких скобок здесь!

      laser.ticksRemaining--;
      laser.lastTick = now;
      if (laser.ticksRemaining <= 0) laser.active = false;
    }
  }
  
  // Очищаем массив от неактивных или null лазеров
  gameState.lasers = gameState.lasers.filter(l => l && l.active);
}
function updateBombZones(deltaTime) {
  const now = performance.now();
  bombZones.forEach(zone => {
    const elapsed = now - zone.start;
    if (!zone.exploded && elapsed >= 2000) { zone.exploded = true; applyBombDamage(zone.x, zone.y); spawnSupernovaEffect({ x: zone.x, y: zone.y, color: "#00FF00" }); }
    if (zone.exploded) { zone.radius += deltaTime * 100; if (zone.radius >= bombRadius) bombZones.splice(bombZones.indexOf(zone), 1); }
  });
}
function generateLightning(x, y, radius) {
  const points = [];
  const segments = 8; // Количество сегментов молнии
  const angleStep = (Math.PI * 2) / segments;
  
  for (let i = 0; i < segments; i++) {
    const angle = angleStep * i + (Math.random() - 0.5) * 0.5;
    const distance = radius * (0.5 + Math.random() * 0.5);
    const endX = x + Math.cos(angle) * distance;
    const endY = y + Math.sin(angle) * distance;
    
    // Создаём зигзагообразный путь
    const midX = (x + endX) / 2 + (Math.random() - 0.5) * 20;
    const midY = (y + endY) / 2 + (Math.random() - 0.5) * 20;
    
    points.push({ x: x, y: y });
    points.push({ x: midX, y: midY });
    points.push({ x: endX, y: endY });
  }
  
  return points;
}
function updateShockZones(deltaTime) {
  const now = performance.now();
  shockZones.forEach(zone => {
    const elapsed = now - zone.start;
    zone.radius = shockRadius * (elapsed / 5000);
    zone.lightningBolts = zone.lightningBolts.filter(b => b.life > 0);
    zone.lightningBolts.forEach(b => { b.life -= deltaTime; });
    const intensityFactor = elapsed < 500 ? 3 : elapsed < 2000 ? 2 : 1;
    if (!zone.lastBoltTime || now - zone.lastBoltTime > 200 + Math.random() * 150) {
      const boltCount = intensityFactor + Math.floor(Math.random() * intensityFactor);
      for (let i = 0; i < boltCount; i++) {
        zone.lightningBolts.push({ maxLife: 0.3 + Math.random() * 0.3, life: 0.3 + Math.random() * 0.3, points: generateLightning(zone.x, zone.y, zone.radius) });
      }
      zone.lastBoltTime = now;
    }
  });
}
function startTurretCycle(turret) {
  turret.lastFireTime = 0; turret.active = true;
  function cycle() {
    if (!turret.active || turret.health <= 0) return;

    // 🔥 Цель невалидна: мертва, вне радиуса ИЛИ перекрыта камнем — ищем новую
    if (
      !turret.target ||
      turret.target.health <= 0 ||
      Math.hypot(turret.target.x - turret.x, turret.target.y - turret.y) > turret.range ||
      isLineOfSightBlocked(turret.x, turret.y, turret.target.x, turret.target.y)
    ) {
      const candidates = getEnemiesInRange({ x: turret.x, y: turret.y }, turret.range, turret.owner)
        .filter(e => !isLineOfSightBlocked(turret.x, turret.y, e.x, e.y)); // 🔥 только с прямой видимостью
      turret.target = candidates.length > 0 ? candidates[0] : null;
    }

    if (turret.target) {
      const now = performance.now();
      if (now - turret.lastFireTime >= turret.fireRate) {
        fireBullet(turret, turret.target);
        turret.lastFireTime = now;
      }
    }
    turret.turretCycleId = requestAnimationFrame(cycle);
  }
  turret.turretCycleId = requestAnimationFrame(cycle);
}
function cleanUpOffscreenObjects() {
  const margin = 100;
  const screenLeft = -camera.offsetX / camera.scale - margin;
  const screenRight = screenLeft + canvas.width / camera.scale + 2 * margin;
  const screenTop = -camera.offsetY / camera.scale - margin;
  const screenBottom = screenTop + canvas.height / camera.scale + 2 * margin;
  const keep = [];
  for (const unit of gameState.units) {
    const isImportant = ['worker', 'repairman', 'fighter', 'assault', 'elite'].includes(unit.type);
    const isVisible = unit.x > screenLeft && unit.x < screenRight && unit.y > screenTop && unit.y < screenBottom;
    if (isImportant || isVisible) {
      keep.push(unit);
    } else {
      // 🧹 Юнит ушёл за экран — чистим его и возвращаем в пул (иначе утечка памяти)
      unit.__removed = true;
      unit.__inGame = false;
      cleanupUnitState(unit);
      releaseUnitToPool(unit);
      FX_STATE.stats.culled++;
    }
  }
  const keepSet = new Set(keep);
  gameState.units = keep;
  // 🧹 Синхронизируем специализированные массивы
  ['attackers', 'defenders', 'repairmen'].forEach(key => {
    if (Array.isArray(gameState[key])) {
      gameState[key] = gameState[key].filter(u => keepSet.has(u));
    }
  });
  fxInvalidate();
}
function cleanUpBulletsAndParticles() {
  gameState.bullets = gameState.bullets.filter(bullet => bullet.alive && bullet.lifetime > 0);
  gameState.particles = gameState.particles.filter(particle => particle.life > 0);
}
function releaseUnusedMemory() {
  for (let i = gameState.fragments.length - 1; i >= 0; i--) {
    if (gameState.fragments[i].life <= 0) gameState.fragments.splice(i, 1);
  }
  if (quadtree) quadtree.clear();
}
function queueSale(building) {
  if (!building) return;
  if (building.isSelling) return;
  if (!gameState.buildings.includes(building)) return;

  building.isSelling = true;
  window.aiSaleQueue.push(building);
}
function triggerSale(building) {
  if (!building) return;
  if (!gameState.buildings.includes(building)) return;

  // 🛡️ Помечаем здание как уничтоженное ДО удаления из массива
  building.health = 0;
  building.destroyed = true;
  building.active = false;
  // 🧹 Чистим ссылки на это здание во всех очередях юнитов
  gameState.units.forEach(u => {
    if (u.target === building) u.target = null;
    if (Array.isArray(u.commandQueue)) {
      u.commandQueue = u.commandQueue.filter(c => !(c && c.target === building));
    }
    if (Array.isArray(u.suspendedQueue)) {
      u.suspendedQueue = u.suspendedQueue.filter(c => !(c && c.target === building));
      if (!u.suspendedQueue.length) u.suspendedQueue = null;
    }
    if (u.repairIntervalId && u.__repairTarget === building) {
      clearInterval(u.repairIntervalId);
      u.repairIntervalId = null;
      u.busyRepair = false;
    }
  });
  fxInvalidate();

  const owner = building.owner;
  const isPlayerBuilding = owner === playerId;

  const resources =
    typeof getResourcesByOwner === "function"
      ? getResourcesByOwner(owner)
      : (isPlayerBuilding ? gameState.playerResources : gameState.aiResources);

  // Удаляем индикатор производства
  const prodIndicator = document.getElementById("productionIndicator_" + building.id);
  if (prodIndicator) prodIndicator.remove();

  // Останавливаем цикл турели
  if (["turret", "turret2", "turret3"].includes(building.type)) {
    building.active = false;

    if (building.turretCycleId) {
      cancelAnimationFrame(building.turretCycleId);
      building.turretCycleId = null;
    }
  }

  // Удаляем здание из состояния
  gameState.buildings = gameState.buildings.filter(b => b !== building);

  // Эффект разрушения
  if (typeof spawnDestructionFragments === "function") {
    spawnDestructionFragments(
      building.x,
      building.y,
      building.width || 10,
      building.height || 10,
      building.type
    );
  }

  // Возврат 20% стоимости владельцу
  const refundPercent = 0.2;
  const cost = building.buildCost || { gold: 0, silicon: 0, plasma: 0 };

  resources.gold += (cost.gold || 0) * refundPercent;
  resources.silicon += (cost.silicon || 0) * refundPercent;
  resources.plasma += (cost.plasma || 0) * refundPercent;

  if (typeof updateResourceUI === "function") {
    updateResourceUI();
  }

  // Очки игроку, если продано/уничтожено здание ИИ
  if (!isPlayerBuilding) {
    gameState.playerScore += SCORE_VALUES[building.type] || 0;

    if (typeof updateScoreUI === "function") {
      updateScoreUI();
    }
  }

  // Запоминаем место продажи для ИИ-зон риска
  window.soldBuildings.push({
    x: building.x,
    y: building.y,
    type: building.type,
    hpAtSale: building.health,       // 🔥 НОВОЕ: сколько HP было при продаже
    maxHp: building.maxHealth,
    time: performance.now()
  });

  building.isSelling = false;

  if (typeof cleanUpBuildingReferences === "function") {
    cleanUpBuildingReferences();
  }
}
function processAISaleQueue() {
  if (window.aiSaleQueue.length === 0) return;
  if (window.aiSaleCooldown) return;

  const building = window.aiSaleQueue.shift();

  if (building && gameState.buildings.includes(building)) {
    triggerSale(building);
  }

  window.aiSaleCooldown = true;

  setTimeout(() => {
    window.aiSaleCooldown = false;
  }, 6000);
}
// Пример: при уничтожении здания (или продаже) вызываем функцию для маркировки зоны
function onBuildingDestroyed(building) {
  // 🛡️ Помечаем здание как уничтоженное ДО удаления из массива,
  // чтобы фантомные цели в очередях юнитов отсекались fxValidTarget
  building.health = 0;
  building.destroyed = true;
  building.active = false;
  // 🧹 Чистим ссылки на это здание во всех очередях юнитов
  gameState.units.forEach(u => {
    if (u.target === building) u.target = null;
    if (Array.isArray(u.commandQueue)) {
      u.commandQueue = u.commandQueue.filter(c => !(c && c.target === building));
    }
    if (Array.isArray(u.suspendedQueue)) {
      u.suspendedQueue = u.suspendedQueue.filter(c => !(c && c.target === building));
      if (!u.suspendedQueue.length) u.suspendedQueue = null;
    }
    if (u.repairIntervalId && u.__repairTarget === building) {
      clearInterval(u.repairIntervalId);
      u.repairIntervalId = null;
      u.busyRepair = false;
    }
  });
  fxInvalidate();
	if (gameMode === "neural" && building.owner === "ai") {
  recentThreats.push({
    x: building.x,
    y: building.y,
    timestamp: Date.now(),
    type: "destruction",
    severity: 100
  });
}

  // Удаляем индикатор производства/очереди найма, если он существует
  const prodIndicator = document.getElementById("productionIndicator_" + building.id);
  if (prodIndicator) {
    prodIndicator.remove();
  }
  
  // Если здание — турель, останавливаем её активность
  if (building.type === "turret" || building.type === "turret2") {
    building.active = false;
    if (building.turretCycleId) {
      cancelAnimationFrame(building.turretCycleId);
      building.turretCycleId = null;
    }
  }
  
  // Удаляем здание из состояния игры
  gameState.buildings = gameState.buildings.filter(b => b !== building);
  
  // Запускаем эффект разрушения
  spawnDestructionFragments(building.x, building.y, building.width, building.height, building.type);
  
  // Начисляем очки за уничтожение здания, если здание принадлежало ИИ
  if (building.owner === "ai") {
    const points = SCORE_VALUES[building.type] || 0;
    gameState.playerScore += points;
    updateScoreUI();
  }
  
  // Обновляем квадродерево и другие структуры
  cleanUpBuildingReferences();
  
  // Дополнительные действия: реакция на атаку и мобилизация защитников
  //reactToAttack();
  //mobilizeDefendersAround(building);
}
function updateGameState(deltaTime) {
  // 1. Обновляем квадродерево
  quadtree.clear();
  gameState.buildings.forEach(b => quadtree.insert(b));
  gameState.units.forEach(u => quadtree.insert(u));
  gameState.resources.forEach(r => quadtree.insert(r));

  // 🔥 Возвращаем! Кубик в руках обязан следовать за рабочим каждый кадр.
  // Наземный массив gameState.resourceTokens НЕ трогаем!
  gameState.units.forEach(unit => {
    if (unit.type === "worker" && unit.carriedResourceToken) {
      updateWorkerResourceToken(unit);
    }
  });
}
function gameLoop(time) {
  if (gameState.gameEnded) {
    console.log("Игра завершена. Цикл остановлен.");
    return; // Прерываем requestAnimationFrame
  }
  if (isPaused) { gameLoopId = requestAnimationFrame(gameLoop); 
    return; }
  let deltaTime = (time - lastTime) / 1000;
  lastTime = time;
	
  const MAX_DELTA_TIME = 0.1; 
  if (deltaTime > MAX_DELTA_TIME) {
    deltaTime = MAX_DELTA_TIME;
  }

  if (isMobile) {
    frameCounter = (frameCounter + 1) % frameSkipMobile;
    if (frameCounter !== 0) { gameLoopId = requestAnimationFrame(gameLoop); return; }
  }
  if (gameMode === "tutorial") checkTutorialProgress();
  // ИИ вынесен в AIScheduler (aiScheduler.js)
  if (gameMode !== 'pvp') updateCapturePoints();
  updateBuildingsActivation();
  updateUnits(deltaTime);
  updateResources(deltaTime);
  updateResourceTokens(deltaTime);
  updateFragments(deltaTime);
  updateParticles(deltaTime);
  quadtree.clear();
  gameState.buildings.forEach(b => quadtree.insert(b));
  gameState.units.forEach(u => quadtree.insert(u));
  gameState.resources.forEach(r => quadtree.insert(r));
    // 🔥 КОНТРОЛЬ ЧАСТОТЫ ОБНОВЛЕНИЯ ТУМАНА
  fogUpdateTimer += deltaTime;
  if (fogUpdateTimer >= FOG_UPDATE_INTERVAL) {
    updateFogOfWar();
    fogUpdateTimer = 0; // Сбрасываем таймер
  }
  updateBullets(deltaTime);
  updateResourcePhysics(deltaTime);

  rockBuildingAuditTimer += deltaTime;
  if (rockBuildingAuditTimer >= 1.0) {
    rockBuildingAuditTimer = 0;
    if (typeof pushRockOutOfAllBuildings === "function") {
      gameState.resources.forEach(rock => {
        if (rock.hp > 0 && !rock.destroyed) pushRockOutOfAllBuildings(rock, 20);
      });
    }
  }
  updateLasers(); 
  autoRepairDamagedObjects();
  gameState.buildings.forEach(building => {
    if (["turret", "turret2", "turret3"].includes(building.type)) updateTurret(building);
    if (["barracks", "barracks2", "barracks3"].includes(building.type)) processProductionQueue(building);
  });
  gameState.buildings = gameState.buildings.filter(b => b.health > 0);
  updateResourceUI();
    // 🔥 Раз в кадр подчищаем selectedUnits от мёртвых и чужих
  if (selectedUnits.length > 0) sanitizeSelectedUnits();
// 🔥 ИСПРАВЛЕНИЕ: СКАНИРОВАНИЕ ВРАГОВ ДЛЯ ВСЕХ ВОЕННЫХ ЮНИТОВ (игрок + ИИ)
// Раньше работало только для игрока — юниты ИИ летели по commandQueue и игнорировали встречных
gameState.units.filter(unit => 
  (unit.owner === playerId || unit.owner === "ai") && 
  ["fighter", "assault", "elite"].includes(unit.type) &&
  !unit.isRetreating &&
  unit.health > 0
).forEach(unit => checkForEnemiesAndAttack(unit));  updateGameState(deltaTime);
  try {
    renderGame(); // Основная отрисовка игры
  } catch (err) {
    console.error("[Render Error]", err);
  }
  
  // === ЖЕСТКИЙ ВЫЗОВ ОТРИСОВКИ ГРАФА ===
  if (typeof window.drawGnnOverlay === "function") {
      //console.log("🔥 Attempting to draw GNN Overlay...");
      window.drawGnnOverlay();
  } else {
      console.warn("⚠️ window.drawGnnOverlay is NOT a function!");
  }

  gameLoopId = requestAnimationFrame(gameLoop);
}
// --- Дополнительные функции логики из твоего списка ---
function findNearestAIBuilding(x, y) {
  let nearest = null, minDist = Infinity;
  gameState.buildings.forEach(building => {
    if (building.owner === "ai") {
      const d = Math.hypot(building.x - x, building.y - y);
      if (d < minDist) { minDist = d; nearest = building; }
    }
  });
  return nearest;
}
// 🔥 ШАГ 4 (ФИНАЛ): Детерминированный спавн баз с гарантированным разделением
function getRandomBasePosition(margin = 200, existingBase = null, minDistanceRatio = 0.5) {
  const wW = (typeof worldWidth !== 'undefined' && worldWidth > 0) ? worldWidth : 4200;
  const wH = (typeof worldHeight !== 'undefined' && worldHeight > 0) ? worldHeight : 2200;
  
  const safeMin = margin;
  const safeMaxX = wW - margin;
  const safeMaxY = wH - margin;
  
  // === СЛУЧАЙНАЯ БАЗА (для первой) ===
  if (!existingBase) {
    return {
      x: safeMin + Math.random() * (safeMaxX - safeMin),
      y: safeMin + Math.random() * (safeMaxY - safeMin)
    };
  }
  
  // === ВТОРАЯ БАЗА: ищем в ПРОТИВОПОЛОЖНОЙ части карты ===
  // Определяем, в какой четверти находится существующая база
  const ex = existingBase.x, ey = existingBase.y;
  const cx = wW / 2, cy = wH / 2;
  
  // Зона: противоположная половина по обеим осям
  // Если ex < cx → ищем во правой половине, и наоборот
  const xMin = (ex < cx) ? cx : safeMin;
  const xMax = (ex < cx) ? safeMaxX : cx;
  // Аналогично по Y
  const yMin = (ey < cy) ? cy : safeMin;
  const yMax = (ey < cy) ? safeMaxY : cy;
  
  const minDist = Math.hypot(wW, wH) * minDistanceRatio;
  
  // Пытаемся найти случайную точку в противоположной четверти
  for (let attempt = 0; attempt < 300; attempt++) {
    const x = xMin + Math.random() * (xMax - xMin);
    const y = yMin + Math.random() * (yMax - yMin);
    
    // Проверка 1: расстояние до существующей базы
    const dist = Math.hypot(x - ex, y - ey);
    if (dist < minDist) continue;
    
    // Проверка 2: нет камней рядом
    let rockConflict = false;
    for (const rock of gameState.resources) {
      if (rock.hp <= 0) continue;
      const r = (typeof rock.getCurrentRadius === "function" ? rock.getCurrentRadius() : 20) + 120;
      if (Math.hypot(rock.x - x, rock.y - y) < r) { rockConflict = true; break; }
    }
    if (rockConflict) continue;
    
    return { x, y };
  }
  
  // 🔥 УМНЫЙ FALLBACK: если случайный поиск не удался — берем ПРОТИВОПОЛОЖНЫЙ УГОЛ
  console.warn("[Base Spawn] Случайный поиск не удался, использую детерминированный угол");
  const fallbackX = (ex < cx) ? safeMaxX - 100 : safeMin + 100;
  const fallbackY = (ey < cy) ? safeMaxY - 100 : safeMin + 100;
  return { x: fallbackX, y: fallbackY };
}
function createCapturePointsForBase(base) {
  const pts = [];
  const innerMargin = 80;  // Не вплотную к базе
  const outerMargin = 400; // Максимальный радиус разброса
  
  for (let i = 0; i < 4; i++) {
    // Случайный угол и расстояние вокруг базы
    const angle = (i / 4) * Math.PI * 2 + Math.random() * (Math.PI / 2);
    const dist = innerMargin + Math.random() * (outerMargin - innerMargin);
    
    let x = base.x + Math.cos(angle) * dist;
    let y = base.y + Math.sin(angle) * dist;
    
    // Ограничиваем границами карты
    x = Math.max(30, Math.min(worldWidth - 30, x));
    y = Math.max(30, Math.min(worldHeight - 30, y));
    
    // Проверяем, что точка не внутри камня
    let valid = true;
    for (const rock of gameState.resources) {
      if (rock.hp <= 0) continue;
      const r = (typeof rock.getCurrentRadius === "function" ? rock.getCurrentRadius() : 20) + 20;
      if (Math.hypot(rock.x - x, rock.y - y) < r) { valid = false; break; }
    }
    
    if (valid) {
      pts.push({ x, y });
    } else {
      // Если точка в камне — смещаем её на случайный угол
      const fallbackAngle = Math.random() * Math.PI * 2;
      const fallbackDist = innerMargin + Math.random() * (outerMargin - innerMargin);
      pts.push({
        x: Math.max(30, Math.min(worldWidth - 30, base.x + Math.cos(fallbackAngle) * fallbackDist)),
        y: Math.max(30, Math.min(worldHeight - 30, base.y + Math.sin(fallbackAngle) * fallbackDist))
      });
    }
  }
  
  return pts;
}
function spawnWaveFromCapturePoint(cp) {
  const side = cp.owner;
  if (!side) return;
  let enemyTarget = gameMode === "single"
    ? (side === "player" ? aiBase : playerBase)
    : gameState.buildings.find(b => b.type.startsWith("base") && b.owner !== side);
  if (enemyTarget && !fxValidTarget(enemyTarget)) enemyTarget = null;
  const spawnCenter = { x: cp.x, y: cp.y }, spawnRadius = 50;
  function getRandomSpawnPos(center) {
    const angle = Math.random() * Math.PI * 2, distance = Math.random() * spawnRadius;
    return { x: center.x + distance * Math.cos(angle), y: center.y + distance * Math.sin(angle) };
  }
  for (let i = 0; i < 2; i++) {
    const pos = getRandomSpawnPos(spawnCenter);
    const fighter = getUnitFromPool("fighter", side, pos.x, pos.y);
    addUnit(fighter);
    startFighterCycle(fighter);
    if (enemyTarget) fighter.commandQueue.push({ type: "attack", target: enemyTarget });
  }
  for (let i = 0; i < 1; i++) {
    const pos = getRandomSpawnPos(spawnCenter);
    const assault = getUnitFromPool("assault", side, pos.x, pos.y);
    addUnit(assault);
    startAssaultEliteCycle(assault);
    if (enemyTarget) assault.commandQueue.push({ type: "attack", target: enemyTarget });
  }
}
function animateMoveAndScale(unit, targetX, targetY, targetScale, duration, callback) {
  const startTime = performance.now(), startX = unit.x, startY = unit.y, startScale = unit.scale;
  function step() {
    const now = performance.now();
    let t = Math.min((now - startTime) / duration, 1);
    t = easeOutQuad(t);
    unit.x = startX + t * (targetX - startX); unit.y = startY + t * (targetY - startY); unit.scale = startScale + t * (targetScale - startScale);
    if (t < 1) requestAnimationFrame(step); else if (callback) callback();
  }
  step();
}
function spawnAtBoundary(building, offset = 10) {
  const edge = Math.floor(Math.random() * 4);
  let spawn = { x: building.x, y: building.y }, target = { x: building.x, y: building.y };
  if (edge === 0) { spawn.x = building.x + (Math.random() - 0.5) * building.width; spawn.y = building.y - building.height / 2; target.x = spawn.x; target.y = spawn.y - offset; } 
  else if (edge === 1) { spawn.x = building.x + building.width / 2; spawn.y = building.y + (Math.random() - 0.5) * building.height; target.x = spawn.x + offset; target.y = spawn.y; } 
  else if (edge === 2) { spawn.x = building.x + (Math.random() - 0.5) * building.width; spawn.y = building.y + building.height / 2; target.x = spawn.x; target.y = spawn.y + offset; } 
  else if (edge === 3) { spawn.x = building.x - building.width / 2; spawn.y = building.y + (Math.random() - 0.5) * building.height; target.x = spawn.x - offset; target.y = spawn.y; }
  return { spawn, target };
}
function isBaseVisible(base) {
  if (!base) return false;
  const screenPos = worldToScreen(base.x, base.y);
  return (screenPos.x >= 0 && screenPos.x <= canvas.width && screenPos.y >= 0 && screenPos.y <= canvas.height);
}
function showBuildZone(building, buildingType) {
  clearBuildZones(); showSingleBuildZone(building, buildingType);
  if (building.type === "base" || building.type === "base2" || building.type === "base3" || building.type === "beacon") {
    const searchRadius = 150;
    const nearbyBuildings = gameState.buildings.filter(b => b.owner === playerId && ["warehouse", "barracks", "base", "barracks2", "base2", "barracks3", "base3", "beacon", "repairWorkshop"].includes(b.type) && b !== building && Math.hypot(b.x - building.x, b.y - building.y) <= searchRadius);
    nearbyBuildings.forEach(b => showSingleBuildZone(b, buildingType));
  }
}
function showSingleBuildZone(building, buildingType) {
  const zone = document.createElement("div");
  zone.className = "buildZone";
  const multiplier = building.buildZoneMultiplier || 1;
  const overlaySize = 100 * camera.scale * multiplier;
  const screenPos = worldToScreen(building.x, building.y);
  zone.style.cssText = `width:${overlaySize}px;height:${overlaySize}px;top:${screenPos.y - overlaySize / 2}px;left:${screenPos.x - overlaySize / 2}px;background-color:transparent;box-shadow:0 0 70px 2px rgba(0,255,0,0.2);border-radius:50%;position:absolute;z-index:1000;`;
  zone.addEventListener("click", e => {
    e.stopPropagation();
    const worldPos = screenToWorld(e.clientX, e.clientY);
    placeBuilding(worldPos.x, worldPos.y, buildingType, playerId);
    clearBuildZones();
  });
  document.body.appendChild(zone);
}
function clearBuildZones() {
  document.querySelectorAll(".buildZone").forEach(zone => zone.remove());
  const buildMenu = document.getElementById("buildMenu");
  if (buildMenu) buildMenu.remove();
}
function seededRandom(seed) {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return function () { state = state * 16807 % 2147483647; return (state - 1) / 2147483646; };
}
function startLaserEffect(laser) {
  const shooter = laser.shooter;
  if (!shooter || typeof shooter.x !== 'number' || typeof shooter.y !== 'number') return;
  laser.visualFlash = { x: shooter.x, y: shooter.y, radius: 20, duration: 200, createdAt: performance.now() };
}
function applyBurningEffect(entity) {
  if (!entity || entity.burning) return;
  entity.burning = true; entity.burnTime = performance.now(); entity.burnDuration = 3000; entity.burnIntensity = 1;
}
function fireLaserShot(shooter, target) {
  if (!Array.isArray(gameState.lasers)) gameState.lasers = [];
  if (!shooter || !target || shooter.health <= 0 || target.health <= 0) return;
  const laser = { shooter, target, damage: shooter.damage || TURRET_LASER_CONFIG.damage, startTime: performance.now(), active: true, ticksRemaining: 5, tickInterval: 1000, lastTick: performance.now() };
  gameState.lasers.push(laser);
  if (gameMode === "pvp" && shooter.type === "turret3" && shooter.owner === playerId) {
    sendPvpAction({ type: "turretFire", turretId: shooter.id, turretType: shooter.type, targetId: target.id });
  }
  startLaserEffect(shooter, target);
}
function assignGroup(groupNumber) {
  const groupKey = `group${groupNumber}`;
  if (!unitGroups[groupKey]) unitGroups[groupKey] = [];
  if (selectedUnits.length === 0) { selectedUnits = unitGroups[groupKey].filter(u => gameState.units.includes(u)); return; }
  const allInTargetGroup = selectedUnits.every(u => u.group === groupNumber);
  if (allInTargetGroup) { selectedUnits = unitGroups[groupKey].filter(u => gameState.units.includes(u)); return; }
  const anyFromOtherGroup = selectedUnits.some(u => u.group !== undefined && u.group !== groupNumber);
  if (anyFromOtherGroup) { selectedUnits = unitGroups[groupKey].filter(u => gameState.units.includes(u)); return; }
  selectedUnits = selectedUnits.filter(u => u.owner === playerId);
  selectedUnits.forEach(unit => { if (unit.group === undefined) { unit.group = groupNumber; unitGroups[groupKey].push(unit); } });
}
function selectGroup(groupNumber) {
  const group = unitGroups[`group${groupNumber}`];
  if (group && group.length > 0) {
    selectedUnits = group.filter(unit => unit.owner === playerId && gameState.units.includes(unit) && unit.alive);
  }
}
function handleGroup(groupNum) {
  if (!unitGroups[groupNum]) unitGroups[groupNum] = [];
  const currentGroup = unitGroups[groupNum].filter(u => u.alive && gameState.units.includes(u));
  if (selectedUnits.length > 0 && !arraysEqual(selectedUnits, currentGroup)) { unitGroups[groupNum] = [...selectedUnits]; } 
  else { selectedUnits = currentGroup; }
}
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every(item => b.includes(item));
}
function selectAllFighters() {
  selectedUnits = gameState.units.filter(u => u.owner === playerId && ["fighter", "assault", "elite"].includes(u.type));
}
function commandAttack() {
  sanitizeSelectedUnits();
  if (!selectedUnits.length) return;

  let targetFound = false;

  selectedUnits.forEach(unit => {
    const nearestEnemyBuilding = findNearestEnemyBuilding(unit.x, unit.y);
    
    if (nearestEnemyBuilding) {
      targetFound = true;
      unit.suspendedQueue = null;
      unit.commandQueue = [
        { type: "move", x: nearestEnemyBuilding.x, y: nearestEnemyBuilding.y }, 
        { type: "attack", target: nearestEnemyBuilding }
      ];
      unit.target = nearestEnemyBuilding;
    }
  });

  // 🔥 НОВОЕ: Если враг не найден (все здания в тумане), отправляем выделенных юнитов на разведку!
  if (!targetFound) {
    if (typeof showFloatingHint === "function") {
      showFloatingHint("🛰️ Враг не обнаружен! Отправляю выделенных юнитов на разведку...");
    }
    
    selectedUnits.forEach(unit => {
      unit.suspendedQueue = null;
      unit.target = null;
      // Используем существующую логику поиска тумана
      const scoutTarget = scoutUnitToFog(unit); 
      if (scoutTarget) {
        unit.commandQueue = [{ type: "move", x: scoutTarget.x, y: scoutTarget.y }];
      }
    });
  }
}
function commandDefence() {
    sanitizeSelectedUnits();
  if (!selectedUnits.length) return;
  const myBase = playerBase || gameState.buildings.find(b => b.owner === playerId && b.type.startsWith("base"));
  if (!myBase) return;
  
  selectedUnits.forEach(unit => {
    // 🔥 СБРОС ПАМЯТИ: Игрок дал прямой приказ на защиту, старые "подвешенные" задачи аннулируются
    unit.suspendedQueue = null;
    
    unit.commandQueue = [{ type: "move", x: myBase.x, y: myBase.y }]; 
    unit.defending = true;
    unit.target = null; // Сбрасываем текущую цель атаки, чтобы начать с чистого листа
    
    if (gameMode === "pvp") {
      sendPvpAction({ type: "defend", unitId: unit.id, x: myBase.x, y: myBase.y });
    }
  });
}
function commandScout() {
    sanitizeSelectedUnits();
  if (!selectedUnits.length) return;
  if (!selectedUnits.length) return;
  selectedUnits.forEach(unit => {
    const target = scoutUnitToFog(unit);
    if (!target) return;
    processCommandQueue(unit);
    if (gameMode === "pvp") sendPvpAction({ type: "scout", unitId: unit.id, x: target.x, y: target.y });
  });
}
function findNearestEnemyBuilding(x, y) {
  let nearestBuilding = null, minDistance = Infinity;
  
  gameState.buildings.forEach(building => {
    // Проверяем только вражеские и живые здания
    if (building.owner !== playerId && building.health > 0) {
      
      // 🔥 КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: Игнорируем здания, которые в тумане войны!
      if (typeof isInFogOfWar === "function" && isInFogOfWar(building.x, building.y)) {
        return; // Пропускаем скрытые здания
      }

      const distance = Math.hypot(building.x - x, building.y - y);
      if (distance < minDistance) {
        minDistance = distance;
        nearestBuilding = building;
      }
    }
  });
  
  return nearestBuilding;
}
function setFormation(type) {
    sanitizeSelectedUnits();
  if (!selectedUnits.length) return;
  if (selectedUnits.length === 0) return;
  const centerX = selectedUnits.reduce((sum, u) => sum + u.x, 0) / selectedUnits.length;
  const centerY = selectedUnits.reduce((sum, u) => sum + u.y, 0) / selectedUnits.length;
  let positions = [];
  if (type === 1) {
    const step = 20;
    positions = [[0, -step], [-step, 0], [step, 0], [0, step], [-step, -step], [step, -step], [-step, step], [step, step]];
  } else if (type === 2) {
    positions = selectedUnits.map((_, i) => [i * 30 - (selectedUnits.length * 15), 0]);
  } else if (type === 3) {
    const rows = Math.ceil(Math.sqrt(selectedUnits.length));
    for (let r = 0, i = 0; r < rows && i < selectedUnits.length; r++) {
      const cols = r + 1;
      for (let c = 0; c < cols && i < selectedUnits.length; c++, i++) positions.push([(c - cols / 2) * 25, r * 25]);
    }
  }
  selectedUnits.forEach((unit, i) => {
    const offset = positions[i % positions.length];
    unit.commandQueue = [{ type: "move", x: centerX + offset[0], y: centerY + offset[1] }];
  });
  setTimeout(() => { if (selectedUnits.length > 0) applyFormationBuff([...selectedUnits], type); }, 2000);
  if (gameMode === "pvp") {
    selectedUnits.forEach((unit, i) => {
      const offset = positions[i % positions.length];
      sendPvpAction({ type: "formation", unitId: unit.id, x: centerX + offset[0], y: centerY + offset[1], formationType: type });
    });
  }
}
// ПЕРКИ: РАСШИРЕННАЯ ЛОГИКА С ВИЗУАЛОМ
function showFloatingHint(text) {
  const hint = document.createElement("div");
  hint.textContent = text;
  hint.style.cssText = `position:fixed;top:80px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#00ffff;padding:12px 24px;border-radius:8px;font-size:16px;font-family:'Orbitron',sans-serif;z-index:10000;border:1px solid #00ffff;box-shadow:0 0 20px rgba(0,255,255,0.5);pointer-events:none;animation:fadeInOut 3s ease-in-out;`;
  document.body.appendChild(hint);
  setTimeout(() => hint.remove(), 3000);
}
function applyShockEffect(x, y) {
  shockZones.push({ x, y, start: performance.now(), radius: 0, maxRadius: 180, lightningBolts: [], lastBoltTime: 0 });
  gameState.units.forEach(unit => {
    if (unit.owner !== playerId) {
      const dist = Math.hypot(unit.x - x, unit.y - y);
      if (dist <= 180) {
        const damage = 30 * (1 - dist / 180);
        
        // ИСПРАВЛЕНО: Вызываем onDamage, чтобы сработал GnnEventHooks.onUnitDamaged
        if (typeof window.onDamage === "function") {
          window.onDamage(unit, damage);
        } else {
          unit.health -= damage; // Fallback
        }
        
        unit.shockedUntil = Math.max(unit.shockedUntil || 0, performance.now() + 3000);
        unit.commandQueue = []; 
        unit.target = null;
        // ИСПРАВЛЕНО: используем performance.now() вместо несуществующей переменной now
        unit.lastAutonomousActionTime = performance.now(); 
      }
    }
  });
}
function applyBombDamage(x, y) {
  gameState.units.forEach(unit => {
    if (unit.owner !== playerId) {
      const dist = Math.hypot(unit.x - x, unit.y - y);
      if (dist <= bombRadius) {
        const damage = bombMaxDamage * (1 - dist / bombRadius);
        
        if (typeof window.onDamage === "function") {
          window.onDamage(unit, damage);
        } else {
          unit.health -= damage;
        }
        
        if (unit.health <= 0) {
          removeUnit(unit);
        } else { 
          unit.burning = true; 
          unit.burnTime = performance.now(); 
          unit.burnDuration = 5000; 
          // ДОБАВЛЕНО: защита от перехвата GNN, пока юнит горит
          unit.lastAutonomousActionTime = performance.now();
        }
      }
    }
  });
}
function activateShockPerk(slotIndex) {
  if (perkAwaitingTarget || Date.now() < perkCooldowns[slotIndex]) return;
  perkAwaitingTarget = true; shockActive = true; 
  perkCooldowns[slotIndex] = Date.now() + 25000;
  if (typeof updatePerkSlots === "function") updatePerkSlots();
  document.body.style.cursor = "crosshair";
  showFloatingHint("⚡ Выберите цель для ЭМИ-удара");
}
function activateBombPerk(slotIndex) {
  if (perkAwaitingTarget || Date.now() < perkCooldowns[slotIndex]) return;
  perkAwaitingTarget = true; bombActive = true; 
  perkCooldowns[slotIndex] = Date.now() + 45000;
  if (typeof updatePerkSlots === "function") updatePerkSlots();
  document.body.style.cursor = "crosshair";
  showFloatingHint("💣 Выберите цель для плазменной бомбы");
}
function activateReconPerk(slotIndex) {
  if (reconActive || Date.now() < perkCooldowns[slotIndex]) return;
  reconActive = true; perkAwaitingTarget = true; 
  perkCooldowns[slotIndex] = Date.now() + 20000;
  if (typeof updatePerkSlots === "function") updatePerkSlots();
  document.body.style.cursor = "crosshair";
  showFloatingHint("🛰️ Выберите зону для разведки");
  
  reconConfirmCallback = (x, y) => {
    reconZones.push({ x, y, start: Date.now(), duration: 12000, radius: 0, maxRadius: 250, scanAngle: 0 });
    // Логика открытия тумана войны (уже частично есть в твоем updateFogOfWar)
    reconActive = false; perkAwaitingTarget = false; reconConfirmCallback = null;
    document.body.style.cursor = "default";
  };
  reconCancelCallback = () => {
    reconActive = false; perkAwaitingTarget = false; reconConfirmCallback = null;
    document.body.style.cursor = "default";
  };
}
function handlePerkClick(pos) {
  if (!perkAwaitingTarget) return false;
  if (shockActive) {
    applyShockEffect(pos.x, pos.y);
    shockActive = false; perkAwaitingTarget = false; document.body.style.cursor = "default";
    return true;
  }
  if (bombActive) {
    applyBombEffect(pos.x, pos.y);
    bombActive = false; perkAwaitingTarget = false; document.body.style.cursor = "default";
    return true;
  }
  if (reconActive && typeof reconConfirmCallback === "function") {
    reconConfirmCallback(pos.x, pos.y);
    return true;
  }
  return false;
}
function findFogTargetAroundBase(base, radius = 400, angleAttempts = 20) {
  let best = null, maxScore = -1;
  for (let i = 0; i < angleAttempts; i++) {
    const angle = (Math.PI * 2 / angleAttempts) * i + Math.random() * 0.2;
    let tx = base.x + radius * Math.cos(angle), ty = base.y + radius * Math.sin(angle);
    tx = Math.max(50, Math.min(worldWidth - 50, tx)); ty = Math.max(50, Math.min(worldHeight - 50, ty));
    const col = Math.floor(tx / FOG_CELL_SIZE), row = Math.floor(ty / FOG_CELL_SIZE);
    if (fogMap[row] && fogMap[row][col] === 0) {
      const dist = Math.hypot(tx - base.x, ty - base.y);
      const score = dist + Math.random() * 50;
      if (score > maxScore) { maxScore = score; best = { x: tx, y: ty }; }
    }
  }
  return best;
}
function scoutUnitToFog(unit) {
  // 🔥 СБРОС ПАМЯТИ: Игрок приказал разведывать, забываем старые задачи
  unit.suspendedQueue = null;
  unit.target = null;

  const startCol = Math.floor(unit.x / FOG_CELL_SIZE);
  const startRow = Math.floor(unit.y / FOG_CELL_SIZE);
  const maxRadius = 60; // Увеличили радиус поиска для масштабных карт
  
  // 🔥 ПРИОРИТЕТ 1: Ищем абсолютно НЕИССЛЕДОВАННЫЕ клетки (persistentFogMap === 0)
  // Это "белые пятна", где мы никогда не были.
  for (let r = 1; r < maxRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // Только периметр
        
        const col = startCol + dx, row = startRow + dy;
        if (row >= 0 && row < persistentFogMap.length && col >= 0 && col < persistentFogMap[0].length) {
          if (persistentFogMap[row][col] === 0) {
            const x = col * FOG_CELL_SIZE + FOG_CELL_SIZE / 2;
            const y = row * FOG_CELL_SIZE + FOG_CELL_SIZE / 2;
            unit.commandQueue = [{ type: "move", x, y }]; 
            return { x, y, type: "unexplored" };
          }
        }
      }
    }
  }

  // 🔥 ПРИОРИТЕТ 2: Если всё исследовано, ищем клетки, которые СЕЙЧАС не видны (fogMap === 0)
  // Это нужно, чтобы вернуть контроль над потерянной зоной.
  for (let r = 1; r < maxRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        
        const col = startCol + dx, row = startRow + dy;
        if (row >= 0 && row < fogMap.length && col >= 0 && col < fogMap[0].length) {
          if (fogMap[row][col] === 0) {
            const x = col * FOG_CELL_SIZE + FOG_CELL_SIZE / 2;
            const y = row * FOG_CELL_SIZE + FOG_CELL_SIZE / 2;
            unit.commandQueue = [{ type: "move", x, y }]; 
            return { x, y, type: "hidden" };
          }
        }
      }
    }
  }
  
  return null;
}
function applyFormationBuff(units, formationType) {
  const now = performance.now();
  let buff = null;
  if (formationType === 1) buff = { type: "hp", value: 0.05 };
  if (formationType === 2) buff = { type: "speed", value: 0.07 };
  if (formationType === 3) buff = { type: "damage", value: 0.10 };
  if (!buff) return;
  const BASE_UNIT_DAMAGE = { fighter: 20, assault: 30, elite: 50 };
  units.forEach(unit => {
    if (buff.type === "hp") { unit.maxHealth *= (1 + buff.value); unit.health *= (1 + buff.value); } 
    else if (buff.type === "speed") { unit.speed = (unit.speed || WORKER_SPEED) * (1 + buff.value); } 
    else if (buff.type === "damage") { unit.damage = (BASE_UNIT_DAMAGE[unit.type] || 5) * (1 + buff.value); }
    unit.formationBuff = { ...buff, appliedAt: now };
  });
  setTimeout(() => {
    units.forEach(unit => {
      if (!unit.formationBuff || unit.formationBuff.appliedAt !== now) return;
      if (buff.type === "hp") { unit.health /= (1 + buff.value); unit.maxHealth /= (1 + buff.value); } 
      else if (buff.type === "speed") { unit.speed = null; } 
      else if (buff.type === "damage") { unit.damage = null; }
      unit.formationBuff = null;
    });
  }, 5000);
}
function triggerPerkSlot(slotIndex) {
  const perkId = equippedPerks[slotIndex];
  if (!perkId || Date.now() < perkCooldowns[slotIndex]) return;
  if (perkId === "shock") activateShockPerk(slotIndex);
  else if (perkId === "bomb") activateBombPerk(slotIndex);
  else if (perkId === "recon") activateReconPerk(slotIndex);
}
