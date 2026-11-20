let isPaused = false;
let lastTime = performance.now();
let gameLoopId;
let frameCounter = 0;
const frameSkipMobile = 2;
let swarmFrameCounter = 0;
let particleUpdateAccumulator = 0;
let idCollisionCount = 0;
const PARTICLE_UPDATE_INTERVAL = 0.033;
const unitGroups = { group1: [], group2: [], group3: [] };
// 🧱 ФУНДАМЕНТ ФИКСОВ — состояние и хелперы
const FX_MIL = ["fighter", "assault", "elite"];
const FX_STATE = {
  frame: 0,
  stats: { phantom: 0, ghost: 0, zombie: 0, dupPool: 0, dupAdd: 0, doubleRemove: 0, culled: 0, mg: 0, rockets: 0 },
  _bs: new Set(), _us: new Set(), _ts: -1e9
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
  // 🔥 УПРОЩЕНО: убираем проверку в кэшированном Set (он обновляется раз в 100мс,
  // из-за чего свежезаспавненные юниты не видятся как валидные цели)
  // Проверка health > 0 + флаги destroyed/isSelling достаточны
  if (!t) return false;
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
  u.__epoch = (u.__epoch || 0) + 1; u.__phaseInit = false; u.__physFrame = -1; u.__eliteFrame = -1;
  u.suspendedQueue = null; u.moveTarget = null; u.moveCallback = null;
  u.commandQueue = []; u.target = null; u.isRetreating = false; u.isDashing = false;
  u.retreatTarget = null; u.returnToBattleCooldown = 0; u.dashEndTime = 0; u.postDashTimer = 0; u.dashVector = { x: 0, y: 0 };
  u.lastAutonomousActionTime = 0; u.lastBurnTick = 0; u.lastShockEffect = 0;
  u.sparkTimer = 0; u.isRepairing = false; u.busyRepair = false; u.__repairTarget = null;
  u.missionLog = null; u.shockedUntil = 0; u.shocked = false; u.burning = false; u.burnTime = 0; u.burnStartTime = 0; u.burnDuration = 0;
  u.hidden = false; u.hiding = false; u.inWorkshop = null; u.delivering = false; u.carrying = 0; u.carriedResourceToken = null;
  u.assignedResource = null; u.assignedResourceType = null; u.laserBeam = null; u.vx = 0; u.vy = 0;
  if (u.repairIntervalId) { clearInterval(u.repairIntervalId); u.repairIntervalId = null; }
  if (u.burningIntervalId) { clearInterval(u.burningIntervalId); u.burningIntervalId = null; }
  if (u.currentMovementAnimation) { cancelAnimationFrame(u.currentMovementAnimation); u.currentMovementAnimation = null; }
  if (u.waitingAnimation) { cancelAnimationFrame(u.waitingAnimation); u.waitingAnimation = null; }
  if (u.__cycleId) { cancelAnimationFrame(u.__cycleId); u.__cycleId = null; }
  if (u.__repairCycleId) { cancelAnimationFrame(u.__repairCycleId); u.__repairCycleId = null; }
  u.__fragmentsSpawned = false;
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
// 🔥 GNN СОБЫТИЙНЫЕ ХУКИ (Mission Logging)
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

function addUnit(unit) {
if (!unit) return unit;
// 🛡️ Проверяем РЕАЛЬНОЕ присутствие в массиве, а не флаг
if (gameState.units.indexOf(unit) !== -1) { FX_STATE.stats.dupAdd++; return unit; }
unit.__inGame = true;
unit.__removed = false;
unit.__inPool = false;
unit.__pooled = false;
fxEnsureCombat(unit);
fxSanitizeOrders(unit);
// 🔥 АВТОМАТИЧЕСКОЕ ПРИСВАИВАНИЕ ID, если его нет
if (!unit.id) unit.id = generateUniqueUnitId();
// ПРОВЕРКА: нет ли уже ДРУГОГО юнита с таким ID?
if (gameState.units.some(u => u !== unit && u.id === unit.id)) {
console.warn(`[⚠️ ID COLLISION] Юнит с ID ${unit.id} уже существует! Генерируем новый...`);
unit.id = generateUniqueUnitId();
}
gameState.units.push(unit);
if (unit.type === "fighter" || unit.type === "assault" || unit.type === "elite") gameState.attackers.push(unit);
if (unit.type === "repairman") gameState.repairmen.push(unit);
if (unit.defending) gameState.defenders.push(unit);
fxInvalidate();
return unit;
}

function removeUnit(unit, killer = null) {
if (!unit) return;
// 🛡️ Смерть строго один раз: иначе двойные очки, двойные осколки и дубль в пуле
if (gameState.units.indexOf(unit) !== -1) {
  unit.__removed = false;   // объект реально в игре — снимаем протухшие флаги
  unit.__inPool = false;
} else if (unit.__removed || unit.__inPool) {
  FX_STATE.stats.doubleRemove++;
  return;
}
unit.__removed = true;
unit.__inGame = false;
if (!killer && unit.__lastAttacker) killer = unit.__lastAttacker;
fxInvalidate();
// 🔥 ХУК СМЕРТИ
if (typeof window.GnnEventHooks !== 'undefined') window.GnnEventHooks.onUnitDeath(unit, killer);
cleanupUnitState(unit);
  for (let key in unitGroups) unitGroups[key] = unitGroups[key].filter(u => u !== unit);
  if (gameMode === "pvp" && unit.owner === playerId) sendPvpAction({ type: "die", unitId: unit.id });
// 🛡️ ОСКОЛКИ СТРОГО ОДИН РАЗ (onDamage уже мог их породить)
if (!unit.__fragmentsSpawned) {
  unit.__fragmentsSpawned = true;
  spawnDestructionFragments(unit.x, unit.y, unit.width || 10, unit.height || 10, unit.type);
}  
  if (unit.assignedResource) { 
    unit.assignedResource.currentWorkers = Math.max(0, unit.assignedResource.currentWorkers - 1); 
    unit.assignedResource = null; 
  }
  
  if (unit.type === "worker" && unit.homeWarehouse) {
    unit.homeWarehouse.workers = Math.max(0, unit.homeWarehouse.workers - 1);
    
    // 🔥 ИСПРАВЛЕНИЕ БАГА: Освобождаем слот доставки, если рабочий умер/удален во время доставки
    if (unit.delivering && unit.homeWarehouse.currentDeliveryWorkers > 0) {
      unit.homeWarehouse.currentDeliveryWorkers--;
    }
  }
  
  if (unit.type === "repairman" && unit.homeWorkshop) {
    unit.homeWorkshop.repairman = Math.max(0, unit.homeWorkshop.repairman - 1);
  }
  
  if (unit.owner === "ai") { 
    gameState.playerScore += SCORE_VALUES[unit.type] || 0; 
    updateScoreUI(); 
  }
  
  gameState.units = gameState.units.filter(u => u !== unit);
  gameState.attackers = gameState.attackers.filter(u => u !== unit);
  gameState.defenders = gameState.defenders.filter(u => u !== unit);
  gameState.repairmen = gameState.repairmen.filter(u => u !== unit);
  
  releaseUnitToPool(unit);
}

function cleanupUnitState(unit) {
  if (unit.repairIntervalId) { clearInterval(unit.repairIntervalId); unit.repairIntervalId = null; }
  unit.isRepairing = false; unit.repairSparkTimer = null;
  if (unit.burningIntervalId) { clearInterval(unit.burningIntervalId); unit.burningIntervalId = null; }
  unit.isBurning = false; unit.burningTimer = 0;
  unit.shocked = false; unit.shockTimer = 0; unit.frozen = false; unit.freezeTimer = 0;
  unit.target = null; unit.commandQueue = []; unit.group = undefined; unit.selected = false;
}

function cleanUpBuildingReferences() {
  if (typeof quadtree !== 'undefined' && quadtree !== null) {
    quadtree.clear();
    gameState.buildings.forEach(b => quadtree.insert(b));
    gameState.units.forEach(u => quadtree.insert(u));
    gameState.resources.forEach(r => quadtree.insert(r));
  }
}

function releaseUnitToPool(unit) {
// 🛡️ Один объект не может лежать в пуле дважды
if (unit.__inPool) { FX_STATE.stats.dupPool++; return; }
unit.__inPool = true;
unit.__inGame = false;
unit.__epoch = (unit.__epoch || 0) + 1;
// 🧹 Стираем память прошлой жизни — источник фантомных приказов
unit.suspendedQueue = null;
unit.moveTarget = null;
unit.moveCallback = null;
unit.isRetreating = false;
fxInvalidate();
// 🔥 ПОЛНЫЙ СБРОС всех полей перед возвратом
unit.alive = false;
  unit.commandQueue = [];
  unit.target = null;
  unit.hidden = false;
  unit.hiding = false;
  unit.inWorkshop = null;
  unit.defending = false;
  unit.group = undefined;
  unit.selected = false;
  unit.maneuvering = false;
  unit.formationBuff = null;
  unit.burning = false;
  unit.shocked = false;
  unit.frozen = false;
  unit.carrying = 0;
  unit.delivering = false;
  unit.carriedResourceToken = null;
  unit.assignedResource = null;
  unit.assignedResourceType = null;
  unit.homeWarehouse = null;
  unit.homeWorkshop = null;
  unit.homeBuilding = null;
  unit.busyRepair = false;
  unit.laserBeam = null;
  unit.damage = undefined;
  unit.speed = undefined;
  unit.vx = 0;
  unit.vy = 0;
  unit.angle = 0;
  unit.scale = 1;
  unit.idleTimer = 0;
  unit.attackCooldown = 0;
  
  if (unit.repairIntervalId) { clearInterval(unit.repairIntervalId); unit.repairIntervalId = null; }
  if (unit.burningIntervalId) { clearInterval(unit.burningIntervalId); unit.burningIntervalId = null; }
  if (unit.currentMovementAnimation) { cancelAnimationFrame(unit.currentMovementAnimation); unit.currentMovementAnimation = null; }
  if (unit.waitingAnimation) { cancelAnimationFrame(unit.waitingAnimation); unit.waitingAnimation = null; }
  
  if (!unitPools[unit.type]) unitPools[unit.type] = [];
  unitPools[unit.type].push(unit);
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
// ЕДИНЫЙ ДВИЖОК ДВИЖЕНИЯ (Заменить старый moveUnit и логику в core.js)
// 1. Функция только ЗАДАЕТ цель движения и коллбек, не выполняя анимацию
function moveUnit(unit, targetX, targetY, callback) {
  if (unit.shocked || unit.isRetreating || unit.health <= 0) return;
  
  // Сбрасываем старую анимацию, если она была
  if (unit.currentMovementAnimation) {
    cancelAnimationFrame(unit.currentMovementAnimation);
    unit.currentMovementAnimation = null;
  }

  // Сохраняем цель и колбек прямо в юните для обработки в главном цикле
  unit.moveTarget = { x: targetX, y: targetY };
  unit.moveCallback = callback;
  unit.angle = Math.atan2(targetY - unit.y, targetX - unit.x);
}
// 2. ЕДИНАЯ функция обновления позиции (вызывается из updateUnits каждый кадр)
function applyUnitMovement(unit, deltaTime) {
  if (unit.shocked || unit.health <= 0) return;

// 🔥 ПРИОРИТЕТ 0: ОТСТУПЛЕНИЕ (теперь летит к МАСТЕРСКОЙ, а не к базе!)
if (unit.isRetreating) {
  // 🔥 ИСПОЛЬЗУЕМ СОХРАНЁННУЮ ЦЕЛЬ (мастерская или fallback на базу)
  let target = unit.retreatTarget;
  
  // Проверка валидности цели (вдруг мастерскую уничтожили, пока мы летели)
  if (!target || target.health <= 0 || !target.active) {
    // Ищем новую мастерскую
    const workshops = gameState.buildings.filter(b => 
      b.owner === unit.owner && 
      b.type === 'repairWorkshop' && 
      b.active && 
      b.health > 0
    );
    
    if (workshops.length > 0) {
      target = workshops.sort((a, b) => 
        Math.hypot(a.x - unit.x, a.y - unit.y) - Math.hypot(b.x - unit.x, b.y - unit.y)
      )[0];
      unit.retreatTarget = target;
    } else {
      // Fallback на базу
      target = unit.owner === "player" ? playerBase : aiBase;
      unit.retreatTarget = target;
    }
  }
  
  if (!target) {
    // Своих построек нет вообще — выходим из отступления
    unit.isRetreating = false;
    unit.retreatTarget = null;
    unit.target = null;
    return;
  }
  
  const dx = target.x - unit.x;
  const dy = target.y - unit.y;
  const dist = Math.hypot(dx, dy);
  
  // 🔥 РАЗНЫЕ ПОРОГИ ДОСТИЖЕНИЯ для мастерской и базы
  const arrivalThreshold = target.type === 'repairWorkshop' ? 40 : 15;
  
  if (dist > arrivalThreshold) {
    unit.angle = Math.atan2(dy, dx);
    const speed = 70; // 🔥 Увеличили скорость отступления с 50 до 70 — юнит быстрее доберётся до лечения
    unit.x += (dx / dist) * speed * deltaTime;
    unit.y += (dy / dist) * speed * deltaTime;
  } else {
    // 🔥 ДОСТИГЛИ ЦЕЛИ!
    if (target.type === 'repairWorkshop') {
      // У мастерской просто останавливаемся и ждём лечения
      // Мастерская сама найдёт нас через startRepairmanCycle
      unit.vx = 0;
      unit.vy = 0;
    } else {
      // У базы — выходим из отступления
      unit.isRetreating = false;
      unit.retreatTarget = null;
      unit.target = null;
    }
  }
  return; // Прерываем, чтобы боевая логика не перехватила управление
}

// ПРИОРИТЕТ 1: Боевая физика
if (["fighter", "assault", "elite"].includes(unit.type) && unit.target && unit.target.health > 0) {
    if (unit.type === "assault") {
        updateAssaultPhysics(unit, unit.target, deltaTime);
    } else if (unit.type === "fighter") {
        const dist = Math.hypot(unit.target.x - unit.x, unit.target.y - unit.y);
        const mode = dist > unit.range ? 'approach' : 'orbit';
        updateFighterPhysics(unit, unit.target, mode, deltaTime);
    } else if (unit.type === "elite") {
        // 🔥 НОВОЕ: своя физика для элиты
        updateElitePhysics(unit, unit.target, deltaTime);
    }
    return;
}
  // ПРИОРИТЕТ 2: Стандартное движение к точке
  if (unit.moveTarget) {
    const dx = unit.moveTarget.x - unit.x;
    const dy = unit.moveTarget.y - unit.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 5) {
      unit.x = unit.moveTarget.x;
      unit.y = unit.moveTarget.y;
      const cb = unit.moveCallback;
      unit.moveTarget = null;
      unit.moveCallback = null;
      if (typeof cb === "function") cb();
      return;
    }

    unit.angle = Math.atan2(dy, dx);
    const speed = unit.speed || (["fighter", "assault", "elite"].includes(unit.type) ? 120 : WORKER_SPEED);
    unit.x += (dx / dist) * speed * deltaTime;
    unit.y += (dy / dist) * speed * deltaTime;
  }
}
// 3. Очищенный менеджер очереди команд (без рекурсивных requestAnimationFrame)
function processCommandQueue(unit, overrideDelta) {
  if (!unit || unit.health <= 0) return;
  if (unit.owner !== playerId && unit.owner !== "ai") return;
  if (unit.shocked) { 
    unit.commandQueue = []; 
    return; 
  }

  // Если очередь пуста, но юнит военный и рядом есть враги — запускаем автономный поиск
  if (unit.commandQueue.length === 0) {
    if (["fighter", "assault", "elite"].includes(unit.type)) {
      checkForEnemiesAndAttack(unit);
    }
    return;
  }

  const command = unit.commandQueue[0]; // Смотрим на первую команду, не удаляя её сразу

  if (command.type === "move") {
    // Если мы уже движемся к этой цели, ничего не делаем, ждем достижения
    if (!unit.moveTarget || unit.moveTarget.x !== command.x || unit.moveTarget.y !== command.y) {
      moveUnit(unit, command.x, command.y, () => {
        unit.commandQueue.shift(); // Удаляем команду только после достижения
        processCommandQueue(unit); // Рекурсивно обрабатываем следующую
      });
    }
  } 
  else if (command.type === "attack") {
    const target = command.target;
    if (!target || target.health <= 0) {
      unit.target = null;
      unit.commandQueue.shift();
      processCommandQueue(unit);
      return;
    }

    unit.target = target;
    const dist = Math.hypot(unit.x - target.x, unit.y - target.y);
    
    // 🔥 КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: Для военных юнитов движение делегировано applyUnitMovement.
    if (["fighter", "assault", "elite"].includes(unit.type)) {
      unit.moveTarget = null;
      unit.moveCallback = null;
      
      // Стреляем только если уже в радиусе поражения
      if (dist <= unit.range) {
        if (unit.type === "elite") dynamicAttackElite(unit, target, overrideDelta || 1/60);
        else if (unit.type === "assault") dynamicAttackAssault(unit, target, overrideDelta || 1/60);
        else dynamicAttack(unit, target, overrideDelta || 1/60);
      }
    } else {
      // Старая логика для рабочих/ремонтников (на всякий случай)
      if (dist > unit.range) {
        moveUnit(unit, target.x, target.y, () => {
          unit.commandQueue.shift();
          processCommandQueue(unit);
        });
      } else {
        unit.moveTarget = null;
        unit.moveCallback = null;
        if (typeof dynamicAttack === "function") dynamicAttack(unit, target, overrideDelta || 1/60);
      }
    }
  } 
  else if (command.type === "gather") {
    const resource = command.resource;
    if (!resource || resource.amount <= 0) {
      unit.commandQueue.shift();
      processCommandQueue(unit);
      return;
    }
    if (!unit.moveTarget || Math.hypot(unit.moveTarget.x - resource.x, unit.moveTarget.y - resource.y) > 5) {
      moveUnit(unit, resource.x, resource.y, () => {
        if (resource.amount > 0) { 
          resource.amount--; 
          unit.carrying = (unit.carrying || 0) + 1; 
        }
        unit.commandQueue.shift();
        
        const deliveryBuilding = findNearestDeliveryBuilding(unit.x, unit.y, unit.owner);
        if (deliveryBuilding) {
          unit.commandQueue.unshift({ type: "move", x: deliveryBuilding.x, y: deliveryBuilding.y, callback: () => {
             // Логика доставки
             const res = unit.owner === playerId ? gameState.playerResources : gameState.aiResources;
             res[resource.type] += unit.carrying; 
             unit.carrying = 0;
             if (resource.amount > 0) unit.commandQueue.unshift({ type: "gather", resource });
             processCommandQueue(unit);
          }});
        } else {
          if (resource.amount > 0) unit.commandQueue.unshift({ type: "gather", resource });
          processCommandQueue(unit);
        }
      });
    }
  }
else if (command.type === "repair") {
  const { workshop, target } = command;
  
  // 🔥 ЖЕСТКАЯ ПРОВЕРКА: Цель мертва, уничтожена, продается или уже полностью здорова?
  if (!target || !fxValidTarget(target) || target.health >= target.maxHealth) {
    unit.commandQueue.shift(); // Удаляем бессмысленную команду к "призраку"
    unit.busyRepair = false;   // Сбрасываем флаг занятости
    processCommandQueue(unit); // Ищем новую, реальную задачу
    return;
  }
  
  // Если мы еще не движемся к этой цели или цель сдвинулась
  if (!unit.moveTarget || Math.hypot(unit.moveTarget.x - target.x, unit.moveTarget.y - target.y) > 5) {
     moveUnit(unit, target.x, target.y, () => {
       // 🔥 ПОВТОРНАЯ ПРОВЕРКА ПОСЛЕ ПРИБЫТИЯ: вдруг цель умерла, пока мы летели?
       if (!target || !fxValidTarget(target) || target.health >= target.maxHealth) {
         unit.commandQueue.shift();
         unit.busyRepair = false;
         processCommandQueue(unit);
         return;
       }
       
       unit.commandQueue.shift(); // Команда выполнена, удаляем
       startRepairProcess(unit, command);
       processCommandQueue(unit);
     });
  }
}
}
// 4. ЕДИНАЯ ФИЗИКА ДЛЯ ВОЕННЫХ: Сближение + Орбита
function updateFighterPhysics(unit, target, mode, deltaTime) {
  if (!target || !unit) return;

  // 🔥 АНТИ-СЛИПАНИЕ: Разведение в мировом пространстве
  const neighbors = getObjectsInRange({x: unit.x, y: unit.y}, 40)
    .filter(u => u !== unit && u.owner === unit.owner && u.type === unit.type && u.health > 0);
  if (neighbors.length > 0) {
    let sepX = 0, sepY = 0;
    for (let other of neighbors) {
      const dx = unit.x - other.x;
      const dy = unit.y - other.y;
      const d = Math.hypot(dx, dy);
      if (d < 40 && d > 0) {
        const force = (40 - d) / 40;
        sepX += (dx / d) * force * 20
        sepY += (dy / d) * force * 20
      }
    }
    unit.vx += sepX * deltaTime;
    unit.vy += sepY * deltaTime;
  }

  const dist = Math.hypot(target.x - unit.x, target.y - unit.y);
  if (dist === 0) return;

  const angleToTarget = Math.atan2(target.y - unit.y, target.x - unit.x);
  unit.angle = lerpAngle(unit.angle, angleToTarget, 0.15);

  const frontX = Math.cos(unit.angle), frontY = Math.sin(unit.angle);
  const tanX = -frontY, tanY = frontX; // Вектор стрейфа (перпендикулярно цели)

  let ax = 0, ay = 0;

  // 🔥 РЫВОК (прорыв в тыл): имеет высший приоритет над орбитой
  if (mode === 'orbit' && !unit.isDashing && (unit.postDashTimer || 0) <= 0) {
    unit.dashTimer -= deltaTime * 1000;
    if (unit.dashTimer <= 0 && dist < unit.range * 1.2) {
      const dashAngle = angleToTarget + (Math.random() - 0.5) * (Math.PI / 3);
      const dashSpeed = 100; 
      unit.dashVector = { x: Math.cos(dashAngle) * dashSpeed, y: Math.sin(dashAngle) * dashSpeed };
      unit.isDashing = true;
      unit.dashEndTime = performance.now() + 600; 
      unit.dashTimer = Math.random() * 4000 + 4000; 
    }
  }

  if (unit.isDashing) {
    if (performance.now() > unit.dashEndTime) {
      unit.isDashing = false; 
      unit.postDashTimer = 1.5; // Фаза закрепления в тылу
    } else {
      ax = unit.dashVector.x * 3.0;
      ay = unit.dashVector.y * 3.0;
    }
  } else if (mode === 'orbit') {
    const wobble = Math.sin((performance.now() / 500) + (unit.orbitPhase || 0)) * 25;
    const idealDist = (unit.range * 0.75) + wobble;
    let distError = dist - idealDist;

    // 🔥 ФАЗА ЗАКРЕПЛЕНИЯ В ТЫЛУ (после рывка)
    if (unit.postDashTimer > 0) {
      unit.postDashTimer -= deltaTime;
      distError = 0; // Отключаем "пружину" возврата
      
      const decay = unit.postDashTimer / 1.5; 
      // 🔥 ДОБАВИЛИ СТРЕЙФ СЮДА: чтобы после рывка юнит сразу начинал боковое движение
ax = (unit.dashVector.x * 0.3 * decay) + (tanX * 80.0 * (unit.orbitDirection || 1) * (unit.strafeDirection || 1));
ay = (unit.dashVector.y * 0.3 * decay) + (tanY * 80.0 * (unit.orbitDirection || 1) * (unit.strafeDirection || 1));      
    } else {
      // 🔥 СТАНДАРТНАЯ ОРБИТА + СТРЕЙФ (ИСПРАВЛЕННЫЙ)
      unit.strafeTimer -= deltaTime * 1000;
      if (unit.strafeTimer <= 0) {
        // 70% шанс смены направления
        if (Math.random() < 0.7) {
          unit.strafeDirection = (unit.strafeDirection || 1) * -1;
          
          // 🔥 НОВЫЙ ФИКС: Резкий "пинок" (импульс) при смене направления!
          // Это делает смену направления визуально заметной, как реальный маневр уклонения
          unit.vx += (tanX * (unit.strafeDirection || 1)) * 60; 
          unit.vy += (tanY * (unit.strafeDirection || 1)) * 60;
        }
        unit.strafeTimer = Math.random() * 3000 + 500; // 0.5 - 3.5 сек
      }

      const dir = unit.strafeDirection || 1;

      if (Math.abs(distError) < 40) {
        // 🔥 УВЕЛИЧИЛИ стрейф до 80.0. Теперь он доминирует над мелкими колебаниями дистанции
        const dir = (unit.orbitDirection || 1) * (unit.strafeDirection || 1);
        ax = frontX * distError * 2.0 + tanX * 80.0 * dir;
        ay = frontY * distError * 2.0 + tanY * 80.0 * dir;      } else {

      }
    }
  } else {
    // 🔥 СБЛИЖЕНИЕ (approach)
    const desiredDist = unit.range * 0.8;
    const distError = dist - desiredDist;
    ax = frontX * distError * 5.0 + tanX * 8.0 * (unit.orbitDirection || 1) * (unit.strafeDirection || 1);
    ay = frontY * distError * 5.0 + tanY * 8.0 * (unit.orbitDirection || 1) * (unit.strafeDirection || 1);  }

  // Применяем инерцию
  unit.vx = unit.vx * 0.90 + ax * deltaTime;
  unit.vy = unit.vy * 0.90 + ay * deltaTime;

  // Лимит скорости
  const maxSpeed = unit.isDashing ? 100 : 70;
  const curSpeed = Math.hypot(unit.vx, unit.vy);
  if (curSpeed > maxSpeed) {
    unit.vx = (unit.vx / curSpeed) * maxSpeed;
    unit.vy = (unit.vy / curSpeed) * maxSpeed;
  }

  unit.x += unit.vx * deltaTime;
  unit.y += unit.vy * deltaTime;
}

function updateAssaultPhysics(unit, target, deltaTime) {
  if (!target || !unit) return;

  // 1. АНТИ-СЛИПАНИЕ (только для своих штурмовиков)
  const neighbors = getObjectsInRange({x: unit.x, y: unit.y}, 50)
    .filter(u => u !== unit && u.owner === unit.owner && u.type === "assault" && u.health > 0);
  if (neighbors.length > 0) {
    let sepX = 0, sepY = 0;
    for (let other of neighbors) {
      const dx = unit.x - other.x;
      const dy = unit.y - other.y;
      const d = Math.hypot(dx, dy);
      if (d < 50 && d > 0) {
        const force = (50 - d) / 50;
        sepX += (dx / d) * force * 20;
        sepY += (dy / d) * force * 20;
      }
    }
    unit.vx += sepX * deltaTime;
    unit.vy += sepY * deltaTime;
  }

  const dist = Math.hypot(target.x - unit.x, target.y - unit.y);
  if (dist === 0) return;

  const angleToTarget = Math.atan2(target.y - unit.y, target.x - unit.x);
  // Плавный поворот (0.08 вместо 0.15 у файтера) = ощущение тяжелого корабля
  unit.angle = lerpAngle(unit.angle, angleToTarget, 0.08);

  const frontX = Math.cos(unit.angle), frontY = Math.sin(unit.angle);
  const tanX = -frontY, tanY = frontX;

  let ax = 0, ay = 0;

  // 2. УПРАВЛЕНИЕ ФАЗАМИ БОЯ
  unit.phaseTimer -= deltaTime * 1000;
  if (unit.phaseTimer <= 0) {
    if (unit.combatPhase === 'approach') {
      unit.combatPhase = 'retreat';
      unit.phaseTimer = 2000; // 2 сек на откат и залп
      unit.rocketBurstCount = 0;
      unit.rocketBurstTimer = 0;
    } else if (unit.combatPhase === 'retreat') {
      unit.combatPhase = 'approach';
      unit.phaseTimer = Math.random() * 3000 + 3000; // 3-6 сек сближения (это и есть кулдаун между залпами!)
      unit.figure8Phase = Math.random() * Math.PI * 2;
    }
  }

  // 3. ДВИЖЕНИЕ В ЗАВИСИМОСТИ ОТ ФАЗЫ
  if (unit.combatPhase === 'approach') {
  // Плавная восьмерка при сближении (ускорение увеличено для компенсации демпфирования 0.88)
  const approachSpeed = 600;
  const figure8Amplitude = 50;
  const figure8Frequency = 1.2;
  unit.figure8Phase += deltaTime * figure8Frequency;
  const figure8Offset = Math.sin(unit.figure8Phase) * figure8Amplitude;
  ax = frontX * approachSpeed + tanX * figure8Offset * 2.0;
  ay = frontY * approachSpeed + tanY * figure8Offset * 2.0;
  } else if (unit.combatPhase === 'retreat') {
  // Откат назад
  const retreatSpeed = 400;
  ax = -frontX * retreatSpeed;
  ay = -frontY * retreatSpeed;
    
    // 🔥 КРИТИЧЕСКИЙ ФИКС: Выстрел ракетами ТОЛЬКО если цель в радиусе ракет (280)!
    if (dist <= unit.rocketRange) {
      unit.rocketBurstTimer -= deltaTime * 1000;
      if (unit.rocketBurstTimer <= 0 && unit.rocketBurstCount < 3) {
        const targetAngle = Math.atan2(target.y - unit.y, target.x - unit.x);
        const rocket = new Bullet(unit.x, unit.y, targetAngle, MISSILE_CONFIG.speed, unit, target);
        rocket.lifetime = MISSILE_CONFIG.lifetime;
        rocket.damage = MISSILE_CONFIG.damage;
        rocket.splashRadius = MISSILE_CONFIG.splashRadius;
        rocket.splashDamage = MISSILE_CONFIG.splashDamage;
        rocket.isMissile = true;
        rocket.target = target;
        rocket.color = "255,0,0";
        gameState.bullets.push(rocket);
        
        unit.rocketBurstCount++;
        unit.rocketBurstTimer = 400; // 🔥 400мс между ракетами (теперь виден четкий интервал)
        unit.lastRocketFireTime = performance.now();
      }
    }
  }

  // 4. МЯГКИЙ СТРЕЙФ (поверх фазы)
  unit.strafeTimer -= deltaTime * 1000;
  if (unit.strafeTimer <= 0) {
    if (Math.random() < 0.5) { // 50% шанс смены направления
      unit.strafeDirection = (unit.strafeDirection || 1) * -1;
      // Мягкий толчок (30 вместо 100), чтобы не было мгновенного "щелчка" скорости
      unit.vx += (tanX * (unit.strafeDirection || 1)) * 30;
      unit.vy += (tanY * (unit.strafeDirection || 1)) * 30;
    }
    unit.strafeTimer = Math.random() * 4000 + 2000; // 2-6 сек (реже, чем у файтера)
  }

  const dir = unit.strafeDirection || 1;
  // Постоянная боковая сила для плавности (увеличена)
  ax += tanX * 120.0 * dir;
  ay += tanY * 120.0 * dir;

  // 5. ИНЕРЦИЯ И ОГРАНИЧЕНИЕ СКОРОСТИ
  // Чуть больше инерции для ощущения массы (0.88)
  unit.vx = unit.vx * 0.88 + ax * deltaTime;
  unit.vy = unit.vy * 0.88 + ay * deltaTime;

  // Максимальная скорость 90 (медленнее файтера, чувствуется "тяжесть", но динамика сохранена)
  const maxSpeed = 90;
  const curSpeed = Math.hypot(unit.vx, unit.vy);
  if (curSpeed > maxSpeed) {
    unit.vx = (unit.vx / curSpeed) * maxSpeed;
    unit.vy = (unit.vy / curSpeed) * maxSpeed;
  }

  unit.x += unit.vx * deltaTime;
  unit.y += unit.vy * deltaTime;
}

function updateElitePhysics(unit, target, deltaTime) {
    if (!target || !unit || unit.health <= 0) return;

    const dist = Math.hypot(target.x - unit.x, target.y - unit.y);
    if (dist === 0) return;

    const angleToTarget = Math.atan2(target.y - unit.y, target.x - unit.x);
    unit.angle = lerpAngle(unit.angle, angleToTarget, 0.03);

    const frontX = Math.cos(unit.angle), frontY = Math.sin(unit.angle);
    const tanX = -frontY, tanY = frontX;

    const SIEGE_MIN = 380, SIEGE_MAX = 520;   
    const BURN_MIN = 220, BURN_MAX = 340;     
    const MELEE_MAX = 200;                     

    let desiredPhase = unit.combatPhase || 'siege';
    
    if (dist > SIEGE_MAX) {
        desiredPhase = 'approach'; 
    } else if (dist < MELEE_MAX) {
        // 🔥 КУЛДАУН НА ФАЗУ SHRED: не убегает чаще раза в 5 секунд
        const now = performance.now();
        if (!unit.lastShredTime || now - unit.lastShredTime > 5000) {
            desiredPhase = 'shred';
            unit.lastShredTime = now;
        } else {
            desiredPhase = 'burn'; // Вместо побега используем лазер
        }
    } else if (dist >= BURN_MIN && dist <= BURN_MAX) {
        desiredPhase = 'burn';     
    } else if (dist >= SIEGE_MIN && dist <= SIEGE_MAX) {
        desiredPhase = 'siege';    
    } else if (dist > BURN_MAX && dist < SIEGE_MIN) {
        desiredPhase = 'closeIn';  
    }
    
    unit.combatPhase = desiredPhase;
    const panicMode = unit.health < unit.maxHealth * 0.3;

    let ax = 0, ay = 0;

    switch (desiredPhase) {
        case 'approach': {
            const desiredDist = SIEGE_MAX - 30;
            const distError = dist - desiredDist;
            ax = frontX * distError * 1.5;
            ay = frontY * distError * 1.5;
            break;
        }

        case 'siege': {
            if (!unit.siegePhaseAngle) unit.siegePhaseAngle = Math.random() * Math.PI * 2;
            unit.siegePhaseAngle += deltaTime * 0.15;

            const orbitX = Math.cos(unit.siegePhaseAngle);
            const orbitY = Math.sin(unit.siegePhaseAngle);
            const idealDist = (SIEGE_MIN + SIEGE_MAX) / 2;
            const distError = dist - idealDist;

            ax = frontX * distError * 1.5 + orbitX * 15;
            ay = frontY * distError * 1.5 + orbitY * 15;

            // 🔥 МЯГКИЙ ОТКАТ ПОСЛЕ ЗАЛПА (уменьшено с 40 до 20)
            if (unit.postVolleyTimer && unit.postVolleyTimer > 0) {
                unit.postVolleyTimer -= deltaTime;
                ax -= frontX * 20; // Было 40
                ay -= frontY * 20;
            }
            break;
        }

        case 'closeIn': {
            const desiredDist = BURN_MAX - 20;
            const distError = dist - desiredDist;
            ax = frontX * distError * 1.5;
            ay = frontY * distError * 1.5;
            break;
        }

        case 'burn': {
            const idealDist = (BURN_MIN + BURN_MAX) / 2;
            const distError = dist - idealDist;
            
            if (!unit.burnDriftTimer) unit.burnDriftTimer = 0;
            unit.burnDriftTimer -= deltaTime;
            if (unit.burnDriftTimer <= 0) {
                unit.burnDriftDir = (unit.burnDriftDir || 1) * -1;
                unit.burnDriftTimer = 6 + Math.random() * 4;
            }
            
            ax = frontX * distError * 1.5 + tanX * 12 * (unit.burnDriftDir || 1);
            ay = frontY * distError * 1.5 + tanY * 12 * (unit.burnDriftDir || 1);
            break;
        }

        case 'shred': {
            // 🔥 МЯГКИЙ ОТКАТ (уменьшено с 2.0 до 1.0)
            const escapeDist = MELEE_MAX + 60; // Было +80
            const distError = dist - escapeDist;
            ax = -frontX * Math.abs(distError) * 1.0; // Было 2.0
            ay = -frontY * Math.abs(distError) * 1.0;
            
            ax += tanX * 15 * (unit.orbitDirection || 1); // Было 25
            ay += tanY * 15 * (unit.orbitDirection || 1);
            break;
        }
    }

    unit.vx = unit.vx * 0.97 + ax * deltaTime;
    unit.vy = unit.vy * 0.97 + ay * deltaTime;

    const maxSpeed = panicMode ? 45 : 40;
    const curSpeed = Math.hypot(unit.vx, unit.vy);
    if (curSpeed > maxSpeed) {
        unit.vx = (unit.vx / curSpeed) * maxSpeed;
        unit.vy = (unit.vy / curSpeed) * maxSpeed;
    }

    unit.x += unit.vx * deltaTime;
    unit.y += unit.vy * deltaTime;
}
// 5. ОБЁРТКА ДЛЯ ДВИЖЕНИЯ В БОЮ (сближение/кайтинг)
function dynamicMove(unit, target, deltaTime) {
  if (!unit || !target || unit.health <= 0) return;
  
  // Очищаем стандартную цель движения, чтобы не конфликтовала с боевой физикой
  unit.moveTarget = null;
  unit.moveCallback = null;
  
  // Используем боевую физику в режиме сближения (approach)
  updateFighterPhysics(unit, target, 'approach', deltaTime);
}

function dynamicAttack(unit, target, deltaTime) {
  if (unit.type === "elite") { 
    dynamicAttackElite(unit, target, deltaTime); 
    return; 
  }
  if (unit.type === "assault") { 
    dynamicAttackAssault(unit, target, deltaTime); 
    return; 
  }
  
  if (!target || target.health <= 0) { 
    unit.target = null; 
    return; 
  }
  
  const currentDistance = Math.hypot(target.x - unit.x, target.y - unit.y);
  if (currentDistance > unit.range) { 
    unit.target = null; 
    return; 
  }
  
  const now = performance.now(); 

  if (unit.type === "fighter") {
  if (unit.shocked) return;
  if (now - unit.lastFireTime >= unit.fireRate) {
  fireBullet(unit, target);
  unit.lastFireTime = now;
  }
  // ✅ ФИЗИКА УЖЕ ОБРАБАТЫВАЕТСЯ В applyUnitMovement
  }
}

function dynamicAttackAssault(unit, target, deltaTime) {
  if (unit.health <= 0 || !target || target.health <= 0) { 
    unit.target = null; 
    return; 
  }
  
  const currentDistance = Math.hypot(target.x - unit.x, target.y - unit.y);
  const now = performance.now();
  
  // Пулемет: стреляем ТОЛЬКО в фазе сближения и ТОЛЬКО в упор
  if (currentDistance <= unit.machineGunRange && 
      (now - unit.lastMachineGunFireTime >= unit.machineGunFireRate) &&
      unit.combatPhase === 'approach') {
    fireBullet(unit, target);
    unit.lastMachineGunFireTime = now;
  }
  
// Ракеты теперь управляются внутри updateAssaultPhysics с проверкой dist <= unit.rocketRange
// 🔥 ФИЗИКА ШТУРМОВИКА УЖЕ ОБРАБАТЫВАЕТСЯ В applyUnitMovement, здесь только стрельба!
}

function dynamicAttackElite(unit, target, deltaTime) {
    if (unit.health <= 0 || !target || target.health <= 0) {
        unit.target = null;
        return;
    }

    const currentDistance = Math.hypot(target.x - unit.x, target.y - unit.y);
    const now = performance.now();

    // 🔥 ПРОВЕРКА БЛИЖНИХ УГРОЗ: переключение на врагов в упор
    const nearbyMeleeEnemies = getEnemiesInRange({x: unit.x, y: unit.y}, unit.meleeRange)
        .filter(e => e.owner !== unit.owner && e.health > 0);
    
    if (nearbyMeleeEnemies.length > 0) {
        // Переключаем цель на ближайшего врага в упор
        target = nearbyMeleeEnemies.sort((a, b) => 
            Math.hypot(a.x - unit.x, a.y - unit.y) - Math.hypot(b.x - unit.x, b.y - unit.y)
        )[0];
        unit.target = target;
    } else {
        // Проверяем врагов в радиусе лазера (220-340)
        const nearbyLaserEnemies = getEnemiesInRange({x: unit.x, y: unit.y}, unit.laserRange)
            .filter(e => e.owner !== unit.owner && e.health > 0 && 
                        Math.hypot(e.x - unit.x, e.y - unit.y) >= 220);
        
        if (nearbyLaserEnemies.length > 0 && currentDistance > unit.laserRange) {
            // Переключаем на ближнего врага для лазера
            target = nearbyLaserEnemies.sort((a, b) => 
                Math.hypot(a.x - unit.x, a.y - unit.y) - Math.hypot(b.x - unit.x, b.y - unit.y)
            )[0];
            unit.target = target;
        }
    }

    // Пересчитываем дистанцию после возможного переключения цели
    const dist = Math.hypot(target.x - unit.x, target.y - unit.y);

    // Держим дистанцию
    const preferredRange = unit.artilleryPreferredRange || unit.artilleryRange || 500;
    if (dist < preferredRange * 0.8) {
        const angleAway = Math.atan2(unit.y - target.y, unit.x - target.x);
        dynamicMove(unit, { x: target.x + Math.cos(angleAway) * preferredRange, y: target.y + Math.sin(angleAway) * preferredRange }, deltaTime);
    } else if (dist > preferredRange * 1.2) {
        dynamicMove(unit, target, deltaTime);
    }

    // 🔥 КАРТЕЧЬ (приоритет выше арты!)
    if (dist <= unit.meleeRange && now - unit.lastMeleeAttack >= unit.meleeCooldown) {
        if (typeof spaceAudio !== 'undefined') {
            spaceAudio.play('melee', 100, 0.15, 0.6);
        }
        
        const desiredAngle = Math.atan2(target.y - unit.y, target.x - unit.x);
        const pelletCount = 9;
        const spreadAngle = 40 * Math.PI / 180;
        
        for (let i = 0; i < pelletCount; i++) {
            const angleOffset = -spreadAngle / 2 + (spreadAngle * i) / (pelletCount - 1);
            let pellet = new Bullet(unit.x, unit.y, desiredAngle + angleOffset, MELEE_BULLET_CONFIG.speed, unit, target);
            pellet.lifetime = MELEE_BULLET_CONFIG.lifetime;
            pellet.damage = MELEE_BULLET_CONFIG.damage;
            pellet.isMelee = true;
            pellet.color = "255,165,0";
            gameState.bullets.push(pellet);
        }
        unit.lastMeleeAttack = now;
    }

    // 🔥 АРТИЛЛЕРИЯ (только если НЕТ врагов в упор!)
    const noMeleeThreats = nearbyMeleeEnemies.length === 0;
    if (noMeleeThreats && dist <= unit.artilleryRange && now - unit.lastArtilleryAttack >= unit.artilleryCooldown) {
        if (typeof spaceAudio !== 'undefined') {
            spaceAudio.play('artillery', 80, 0.6, 0.7);
        }
        
        const desiredAngle = Math.atan2(target.y - unit.y, target.x - unit.x);
        const artilleryCount = 5 + Math.floor(Math.random() * 6);
        
        for (let i = 0; i < artilleryCount; i++) {
            let artillery = new Bullet(unit.x, unit.y, desiredAngle + (Math.random() - 0.5) * 0.2, ARTILLERY_BULLET_CONFIG.speed, unit, target);
            artillery.lifetime = ARTILLERY_BULLET_CONFIG.lifetime;
            artillery.damage = ARTILLERY_BULLET_CONFIG.damage;
            artillery.splashRadius = ARTILLERY_BULLET_CONFIG.splashRadius;
            artillery.splashDamage = ARTILLERY_BULLET_CONFIG.splashDamage;
            artillery.color = "0,255,0";
            artillery.isArtillery = true;
            gameState.bullets.push(artillery);
        }
        
        unit.lastArtilleryAttack = now;
        unit.postVolleyTimer = 0.4; // Было 0.6
    }

    // 🔥 ЛАЗЕР (средний приоритет)
    if (dist <= unit.laserRange && now - unit.lastLaserAttack >= unit.laserCooldown) {
        if (typeof spaceAudio !== 'undefined') {
            spaceAudio.play('laser', 400, 0.15, 0.4);
        }
        
        const laserAngle = Math.atan2(target.y - unit.y, target.x - unit.x);
        unit.laserBeam = {
            startX: unit.x,
            startY: unit.y,
            endX: unit.x + Math.cos(laserAngle) * unit.laserRange,
            endY: unit.y + Math.sin(laserAngle) * unit.laserRange,
            timestamp: now
        };
        
        let hits = 0;
        const enemyCandidates = gameState.units.concat(gameState.buildings)
            .filter(e => e.owner !== unit.owner && e.health > 0)
            .sort((a, b) => 
                ((a.x - unit.x) * Math.cos(laserAngle) + (a.y - unit.y) * Math.sin(laserAngle)) - 
                ((b.x - unit.x) * Math.cos(laserAngle) + (b.y - unit.y) * Math.sin(laserAngle))
            );
        
        for (let enemy of enemyCandidates) {
            const proj = ((enemy.x - unit.x) * Math.cos(laserAngle) + (enemy.y - unit.y) * Math.sin(laserAngle));
            if (proj > 0 && proj < unit.laserRange) {
                const perp = Math.abs(-Math.sin(laserAngle) * (enemy.x - unit.x) + Math.cos(laserAngle) * (enemy.y - unit.y));
                if (perp < 20) {
                    if (typeof onDamage === "function") {
                        onDamage(enemy, 50);
                    } else {
                        enemy.health -= 50;
                        if (enemy.health <= 0) {
                            if (enemy.width !== undefined) { 
                                spawnParticles(enemy.x, enemy.y, "red"); 
                                gameState.buildings = gameState.buildings.filter(b => b !== enemy); 
                            } else { 
                                gameState.units = gameState.units.filter(u => u !== enemy); 
                                selectedUnits = selectedUnits.filter(u => u !== enemy); 
                            }
                        }
                    }
                    hits++; 
                    if (hits >= 3) break;
                }
            }
        }
        unit.lastLaserAttack = now;
    }
}

function checkForEnemiesAndAttack(unit) {
  if (!unit || !unit.range || unit.isRetreating || unit.health <= 0) return;
    // Это разрывает злосчастный цикл
  if (unit.returnToBattleCooldown && performance.now() < unit.returnToBattleCooldown) {
    return; // Юнит ещё "остывает" — не ищем врагов
  }
  fxSanitizeOrders(unit); // 🔥 Чистим призрачные приказы перед поиском
  const enemiesInRange = getEnemiesInRange({ x: unit.x, y: unit.y }, unit.range)
    .filter(e => e.owner !== unit.owner && e.health > 0 && fxValidTarget(e));
  if (enemiesInRange.length > 0) {
    // Если уже атакуем эту цель, ничего не меняем
    if (unit.target && unit.target.health > 0 && enemiesInRange.includes(unit.target)) {
      return;
    }
    // Сохраняем прерванную задачу
    if (unit.commandQueue.length > 0 && !unit.suspendedQueue) {
      unit.suspendedQueue = [...unit.commandQueue];
    }
    // Очищаем текущую очередь и цель движения, чтобы включить боевую физику
    unit.commandQueue = [];
    unit.moveTarget = null;
    unit.moveCallback = null;
    // Находим ближайшего врага
    unit.target = enemiesInRange.sort((a, b) =>
      Math.hypot(a.x - unit.x, a.y - unit.y) - Math.hypot(b.x - unit.x, b.y - unit.y)
    )[0];
    // Ставим приоритетную команду атаки
    unit.commandQueue.push({ type: "attack", target: unit.target });
  } else {
    // Врагов нет. Проверяем, нужно ли вернуться к старой задаче.
    if (unit.suspendedQueue && unit.suspendedQueue.length > 0) {
      const nextTask = unit.suspendedQueue[0];
      let isTaskValid = true;
      if ((nextTask.type === "move" || nextTask.type === "attack") && nextTask.target) {
        if (!fxValidTarget(nextTask.target)) isTaskValid = false;
      }
      if (isTaskValid) {
        unit.commandQueue = [...unit.suspendedQueue];
        unit.suspendedQueue = null;
        unit.target = null;
        fxSanitizeOrders(unit); // 🔥 Чистим восстановленную очередь
      } else {
        unit.suspendedQueue = null;
        unit.target = null;
      }
    } else {
      if (unit.target && !fxValidTarget(unit.target)) {
        unit.target = null;
      }
    }
  }
}

function startRepairmanCycle(repairman) {
  let idleStartTime = performance.now();
  
  function loop() {
    if (!gameState.units.includes(repairman)) return;
    
    const isIdle = !repairman.busyRepair && repairman.commandQueue.length === 0;
    const isOutside = !repairman.hidden;
    
    if (isIdle) {
       // 🔥 ИСПРАВЛЕНИЕ 1: Жесткий радиус поиска 250 (как ты и хотел)
       const repairRadius = 250; 
       
       // 🔥 ИСПРАВЛЕНИЕ 2: Ищем ВСЕХ раненых в радиусе, фильтруем "призраков" и сортируем по близости!
       const damagedUnits = gameState.units.filter(u => 
         u.owner === repairman.owner && 
         fxValidTarget(u) && // <-- Ключевое: цель должна быть живой и валидной!
         u.health > 0 && 
         u.health < u.maxHealth * 0.95 && 
         u !== repairman &&
         Math.hypot(u.x - repairman.x, u.y - repairman.y) <= repairRadius
       ).sort((a, b) => 
         // Сортируем: сначала самые близкие
         Math.hypot(a.x - repairman.x, a.y - repairman.y) - Math.hypot(b.x - repairman.x, b.y - repairman.y)
       );
       
       const damagedUnit = damagedUnits[0]; // Берем ближайшего живого раненого
       
       if (damagedUnit) {
         const distance = Math.hypot(damagedUnit.x - repairman.x, damagedUnit.y - repairman.y);
         if (distance > 10) { 
           repairman.commandQueue = [{ type: "repair", target: damagedUnit, workshop: repairman.homeWorkshop }]; 
           processCommandQueue(repairman); 
         } else { 
           startRepairProcess(repairman, { target: damagedUnit, workshop: repairman.homeWorkshop }); 
         }
         repairman.busyRepair = true;
       } else {
         // Если раненых юнитов в радиусе 250 НЕТ — ищем поврежденные здания (тоже с проверкой валидности)
         const damaged = gameState.buildings.find(b => 
           b.owner === repairman.owner && 
           fxValidTarget(b) && // <-- Здание не должно быть уничтожено или продано
           b.health < b.maxHealth * 0.95 && 
           (!b.repairmen || b.repairmen.length < 3 || b.repairmen.includes(repairman))
         );
         
         if (damaged) {
           if (!damaged.repairmen) damaged.repairmen = [];
           if (!damaged.repairmen.includes(repairman)) damaged.repairmen.push(repairman);
           
           const distance = Math.hypot(damaged.x - repairman.x, damaged.y - repairman.y);
           if (distance > 10) { 
             repairman.commandQueue = [{ type: "repair", target: damaged, workshop: repairman.homeWorkshop }]; 
             processCommandQueue(repairman); 
           } else { 
             startRepairProcess(repairman, { target: damaged, workshop: repairman.homeWorkshop }); 
           }
           repairman.busyRepair = true;
         } else if (isOutside && performance.now() - idleStartTime > 5000) {
           // Возврат в мастерскую, если делать нечего
           const w = repairman.homeWorkshop;
           if (w && fxValidTarget(w)) {
             animateMoveAndScale(repairman, w.x, w.y, 0.1, 700, () => { 
               repairman.hidden = true; 
               repairman.inWorkshop = w; 
             });
           }
         }
       }
     } else { 
       idleStartTime = performance.now(); 
     }
     requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

function startRepairProcess(repairman, command) {
  const target = command.target;
  
  // 🔥 ДОБАВЛЕНО: !fxValidTarget(target)
  if (!target || !fxValidTarget(target) || target.health >= target.maxHealth || target.health <= 0) {
    repairman.busyRepair = false;
    if (target && target.repairmen) {
      target.repairmen = target.repairmen.filter(r => r !== repairman);
    }
    processCommandQueue(repairman);
    return;
  }
  
  const repairRate = 15;
  const intervalTime = 100;
  const REPAIR_COST = { gold: 1, silicon: 4, plasma: 3 };
  const intervalsPerCycle = 5000 / intervalTime;
  const costGoldPerInterval = REPAIR_COST.gold / intervalsPerCycle;
  const costSiliconPerInterval = REPAIR_COST.silicon / intervalsPerCycle;
  const costPlasmaPerInterval = REPAIR_COST.plasma / intervalsPerCycle;
  
  repairman.repairIntervalId = setInterval(() => {
    // 🔥 ПРОВЕРКА ДИСТАНЦИИ И ВАЛИДНОСТИ: если юнит улетел ИЛИ умер/уничтожен
    const distToTarget = Math.hypot(repairman.x - target.x, repairman.y - target.y);
    
    if (distToTarget > 50 || !fxValidTarget(target) || target.health <= 0) {
      clearInterval(repairman.repairIntervalId);
      repairman.repairIntervalId = null;
      repairman.busyRepair = false;
      if (target && target.repairmen) {
        target.repairmen = target.repairmen.filter(r => r !== repairman);
      }
      processCommandQueue(repairman);
      return;
    }
    
    if (target.health >= target.maxHealth || target.health <= 0) {
       clearInterval(repairman.repairIntervalId);
       repairman.repairIntervalId = null;
       repairman.busyRepair = false;
       if (target.repairmen) {
         target.repairmen = target.repairmen.filter(r => r !== repairman);
       }
       processCommandQueue(repairman);
       return;
     }
     
     const resources = target.owner === playerId ? gameState.playerResources : gameState.aiResources;
     if (resources.gold < costGoldPerInterval || resources.silicon < costSiliconPerInterval || resources.plasma < costPlasmaPerInterval) {
       if (target.owner === playerId) showWarning("Недостаточно ресурсов для ремонта");
       clearInterval(repairman.repairIntervalId);
       repairman.repairIntervalId = null;
       repairman.busyRepair = false;
       if (target.repairmen) {
         target.repairmen = target.repairmen.filter(r => r !== repairman);
       }
       processCommandQueue(repairman);
       return;
     }
     
     resources.gold -= costGoldPerInterval;
     resources.silicon -= costSiliconPerInterval;
     resources.plasma -= costPlasmaPerInterval;
     updateResourceUI();
     
     target.health += (repairRate * intervalTime) / 5000;
     if (target.health > target.maxHealth) {
       target.health = target.maxHealth;
     }
     
     if (!repairman.sparkTimer) repairman.sparkTimer = 0;
     repairman.sparkTimer += intervalTime;
     if (repairman.sparkTimer >= 1000) {
       const dist = Math.hypot(repairman.x - target.x, repairman.y - target.y);
       if (dist <= 50) {
         spawnSparkEffect(target.x, target.y);
         spawnSparkEffect(target.x, target.y);
       }
       repairman.sparkTimer = 0;
     }
  }, intervalTime);
}

function updateResources(deltaTime) {
  gameState.resources.forEach(resource => {
    if (resource.type === "gold" && resource.rotationSpeed) resource.rotation += resource.rotationSpeed * deltaTime;
    if (resource.amount <= 0) resource.depleted = true;
  });
  cleanupResources();
}

function cleanupResources() {
  gameState.resources = gameState.resources.filter(resource => resource.amount > 0);
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
  if (!fogMap || fogMap.length === 0 || !fogMap[0]) return;
  const invScale = 1 / camera.scale;
  const viewLeft = -camera.offsetX * invScale, viewTop = -camera.offsetY * invScale;
  const viewRight = viewLeft + canvas.width * invScale, viewBottom = viewTop + canvas.height * invScale;
  const margin = 100;
  const startCol = Math.max(0, Math.floor((viewLeft - margin) / FOG_CELL_SIZE));
  const endCol = Math.min(fogMap[0].length - 1, Math.floor((viewRight + margin) / FOG_CELL_SIZE));
  const startRow = Math.max(0, Math.floor((viewTop - margin) / FOG_CELL_SIZE));
  const endRow = Math.min(fogMap.length - 1, Math.floor((viewBottom + margin) / FOG_CELL_SIZE));
  for (let r = startRow; r <= endRow; r++) {
    for (let c = startCol; c <= endCol; c++) fogMap[r][c] = 0;
  }
  const visionSources = gameState.units.filter(u => u.owner === playerId).concat(gameState.buildings.filter(b => b.owner === playerId));
  visionSources.forEach(source => {
    const visionRadius = source.visionRadius || VISION_RADIUS;
    const sCol = Math.max(0, Math.floor((source.x - visionRadius - margin) / FOG_CELL_SIZE));
    const eCol = Math.min(fogMap[0].length - 1, Math.floor((source.x + visionRadius + margin) / FOG_CELL_SIZE));
    const sRow = Math.max(0, Math.floor((source.y - visionRadius - margin) / FOG_CELL_SIZE));
    const eRow = Math.min(fogMap.length - 1, Math.floor((source.y + visionRadius + margin) / FOG_CELL_SIZE));
    for (let r = sRow; r <= eRow; r++) {
      for (let c = sCol; c <= eCol; c++) {
        const cellCenterX = c * FOG_CELL_SIZE + FOG_CELL_SIZE / 2;
        const cellCenterY = r * FOG_CELL_SIZE + FOG_CELL_SIZE / 2;
        if (Math.hypot(source.x - cellCenterX, source.y - cellCenterY) <= visionRadius) {
          fogMap[r][c] = 1;
          persistentFogMap[r][c] = 1;
        }
      }
    }
  });
  const now = Date.now();
  reconZones.forEach(zone => {
    if (now > zone.start + zone.duration) return;
    const { x, y } = zone; const radius = 80;
    const sCol = Math.max(0, Math.floor((x - radius) / FOG_CELL_SIZE));
    const eCol = Math.min(fogMap[0].length - 1, Math.floor((x + radius) / FOG_CELL_SIZE));
    const sRow = Math.max(0, Math.floor((y - radius) / FOG_CELL_SIZE));
    const eRow = Math.min(fogMap.length - 1, Math.floor((y + radius) / FOG_CELL_SIZE));
    for (let r = sRow; r <= eRow; r++) {
      for (let c = sCol; c <= eCol; c++) {
        const cx = c * FOG_CELL_SIZE + FOG_CELL_SIZE / 2;
        const cy = r * FOG_CELL_SIZE + FOG_CELL_SIZE / 2;
        if (Math.hypot(x - cx, y - cy) <= radius) { fogMap[r][c] = 1; persistentFogMap[r][c] = 1; }
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

function startFighterCycle(fighter) {
  if (!fighter) return;
  function cycle() {
    if (fighter.health <= 0) return;
    
    // 🔥 ИСПРАВЛЕНИЕ: Если юнит отступает, пропускаем фазу атаки и даем ему двигаться
    if (fighter.isRetreating) {
      requestAnimationFrame(cycle);
      return;
    }

    if (fighter.commandQueue.length > 0) { 
      processCommandQueue(fighter); 
      requestAnimationFrame(cycle); 
      return; 
    }
    
    // 🔥 ФИКС: Проверяем, что цель существует, ЖИВА и принадлежит ДРУГОМУ владельцу
    if (fighter.target && fighter.target.health > 0 && fighter.target.owner !== fighter.owner) {
      dynamicAttack(fighter, fighter.target, 1/60); 
    } else {
      // Цель потеряна или мертва — ищем новую
      fighter.target = null;
      
      // Используем безопасный поиск через utils.js
      let enemies = getEnemiesInRange({ x: fighter.x, y: fighter.y }, fighter.range)
        .filter(e => e.owner !== fighter.owner && e.health > 0);
        
      if (enemies.length > 0) {
        fighter.target = enemies.sort((a, b) => 
          Math.hypot(a.x - fighter.x, a.y - fighter.y) - Math.hypot(b.x - fighter.x, b.y - fighter.y)
        )[0];
      }
    }
    requestAnimationFrame(cycle);
  }
  cycle();
}

function processResourceDepletion() {
  gameState.resources.slice().forEach(resource => {
    if (resource.amount <= 10 && !resource.depleted) {
      resource.depleted = true;
      spawnSupernovaEffect(resource);
      setTimeout(() => {
        const idx = gameState.resources.indexOf(resource);
        if (idx !== -1) gameState.resources.splice(idx, 1);
        setTimeout(() => {
          const x = Math.random() * (worldWidth - 40) + 10;
          const y = Math.random() * (worldHeight - 40) + 10;
          gameState.resources.push(new Resource(resource.type, x, y, resource.max, resource.max));
        }, 50000);
      }, 500);
    }
  });
}
// === МИКРО-РЕФЛЕКСЫ ЮНИТОВ (Спинной мозг) ===
function applyUnitMicroReflexes(unit, now) {
  if (unit.health <= 0 || unit.type === "worker" || unit.type === "repairman") return;

  // 1. АВТО-ПЕРЕНАЦЕЛИВАНИЕ
  if (unit.target && unit.target.health <= 0) {
    unit.target = null;
    unit.lastAutonomousActionTime = now;
  }

  // 2. ВКЛЮЧЕНИЕ ОТСТУПЛЕНИЯ (< 20% HP) — с поиском БЛИЖАЙШЕЙ мастерской
  if (unit.health < unit.maxHealth * 0.20 && !unit.isRetreating) {
    // 🔥 ИЩЕМ БЛИЖАЙШУЮ АКТИВНУЮ МАСТЕРСКУЮ (а не базу!)
    const workshops = gameState.buildings.filter(b => 
      b.owner === unit.owner && 
      b.type === 'repairWorkshop' && 
      b.active && 
      b.health > 0
    );
    
    let retreatTarget = null;
    if (workshops.length > 0) {
      // Сортируем по расстоянию и берём ближайшую
      retreatTarget = workshops.sort((a, b) => 
        Math.hypot(a.x - unit.x, a.y - unit.y) - Math.hypot(b.x - unit.x, b.y - unit.y)
      )[0];
    } else {
      // 🔥 FALLBACK: Если мастерских нет — летим к базе
      retreatTarget = unit.owner === "player" ? playerBase : aiBase;
    }
    
    if (!retreatTarget) {
      // Своих построек нет вообще — не входим в отступление, чтобы не застрять
      return;
    }
    
    // 🔥 СОХРАНЯЕМ ЦЕЛЬ ОТСТУПЛЕНИЯ ПРЯМО В ЮНИТЕ
    unit.retreatTarget = retreatTarget;
    unit.isRetreating = true;
    unit.commandQueue = []; 
    unit.target = null;
    unit.lastAutonomousActionTime = now;
    
    // 🔥 НОВОЕ: Кулдаун на возвращение в бой (5 секунд после выхода из отступления)
    unit.returnToBattleCooldown = 0;
    
    return;
  }

  // 3. ВЫХОД ИЗ ОТСТУПЛЕНИЯ — только когда юнит ПОЧТИ ЗДОРОВ (>80% HP)
  // 🔥 КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: порог поднят с 25% до 80%!
  if (unit.isRetreating && unit.health >= unit.maxHealth * 0.80) {
    unit.isRetreating = false;
    unit.retreatTarget = null;
    
    // 🔥 НОВОЕ: Даём юниту 5 секунд "остыть" перед возвращением в бой
    // Это разрывает цикл "вылечился → сразу атаковал → снова ранен → снова отступил"
    unit.returnToBattleCooldown = performance.now() + 5000;
    unit.lastAutonomousActionTime = performance.now() + 5000;
  }
}

function updateUnits(deltaTime) {
  const now = performance.now();
  
  // 1. Обработка зон шока
  shockZones = shockZones.filter(zone => {
    const elapsed = now - zone.start;
    if (elapsed < 5000) {
      gameState.units.forEach(unit => {
        if (unit.owner !== playerId && Math.hypot(unit.x - zone.x, unit.y - zone.y) < shockRadius) {
          unit.shockedUntil = Math.max(unit.shockedUntil || 0, zone.start + 5000);
        }
      });
      return true;
    }
    return false;
  });

  // 2. Основной цикл юнитов
  gameState.units.forEach(unit => {
    // Сначала микро-рефлексы (они только ставят флаг isRetreating, но не двигают юнита)
    applyUnitMicroReflexes(unit, now);

    // 🔥 ЕДИНАЯ ТОЧКА ОБНОВЛЕНИЯ ПОЗИЦИИ (двигает юнита, в том числе при отступлении)
    applyUnitMovement(unit, deltaTime);

    const isShocked = unit.shockedUntil && now < unit.shockedUntil;

    // Логика горения
    if (unit.burning) {
      const elapsed = now - unit.burnTime;
      if (elapsed < unit.burnDuration) {
        if (!unit.lastBurnTick || now - unit.lastBurnTick > 500) { 
          unit.health -= 10; 
          unit.lastBurnTick = now; 
          spawnSparkEffect(unit.x, unit.y); 
        }
      } else { 
        unit.burning = false; 
      }
    }

    // Логика шока (только для ИИ, чтобы дать ему передышку)
    if (isShocked && unit.owner === "ai") {
      if (!unit.lastShockEffect || now - unit.lastShockEffect > 500) { 
        spawnShockEffect(unit.x, unit.y); 
        unit.lastShockEffect = now; 
      }
      unit.shocked = true; 
      unit.commandQueue = []; 
      unit.target = null;
      unit.lastAutonomousActionTime = now + 3000; 
      return; // Выходим из обработки этого юнита на этом кадре
    } else { 
      unit.shocked = false; 
    }

    // 🔥 ИСПРАВЛЕНИЕ БАГА С ЗАВИСАНИЕМ:
    // Мы убрали "!unit.isRetreating" из условий. 
    // Теперь processCommandQueue вызывается ВСЕГДА, даже при отступлении.
    // Это позволяет игроку отменить отступление, просто кликнув правой кнопкой мыши (новая команда перезапишет старую).
    if (unit.health > 0 && !unit.shocked) {
      if (unit.type === "elite" || unit.type === "assault" || unit.type === "fighter" || unit.type === "repairman") { 
        processCommandQueue(unit, deltaTime); 
      } else { 
        unit.idleTimer += deltaTime; 
      }
    }
  });

  // 3. Очистка мертвых юнитов
  gameState.units = gameState.units.filter(unit => {
    if (unit.health <= 0) { 
      removeUnit(unit); 
      return false; 
    }
    return true;
  });

  // 4. Поведение роя (если нужно)
  swarmFrameCounter++;
  if (swarmFrameCounter % 5 === 0) updateSwarmBehavior(deltaTime);
  if (swarmFrameCounter > 1000) swarmFrameCounter = 0;
}
// 🔥 ЕДИНАЯ ТОЧКА НАНЕСЕНИЯ УРОНА (пули + сплэш)
function fxApplyDamage(entity, damage, source) {
  if (!entity || !(entity.health > 0) || !(damage > 0) || entity.destroyed) return;
  if (source) entity.__lastAttacker = source;
  // 🛡️ Устанавливаем флаг ДО onDamage, чтобы onDamage мог нарисовать осколки,
  // а removeUnit — пропустить свой вызов (иначе двойные осколки)
  entity.__fragmentsSpawned = true;
  if (typeof onDamage === "function") {
    onDamage(entity, damage);
  } else {
    entity.health -= damage;
    if (typeof window.GnnEventHooks !== 'undefined') window.GnnEventHooks.onUnitDamaged(entity, damage, source);
  }
  // Страховка добивания: если onDamage не убрал труп — убираем сами, ровно один раз
  if (entity.health <= 0 && !entity.__removed) {
    const isBld = (typeof Building !== "undefined" && entity instanceof Building);
    if (isBld) {
      if (gameState.buildings.indexOf(entity) !== -1) { entity.__removed = true; onBuildingDestroyed(entity); }
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
    
    // Самонаведение ракеты (без создания новых объектов)
    if (bullet.isMissile && bullet.target && bullet.target.health > 0) {
      let desiredAngle = Math.atan2(bullet.target.y - bullet.y, bullet.target.x - bullet.x);
      let angleDiff = desiredAngle - bullet.angle;
      angleDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff));
      bullet.angle += angleDiff * 0.1;
    }
    
    bullet.x += Math.cos(bullet.angle) * bullet.speed * deltaTime;
    bullet.y += Math.sin(bullet.angle) * bullet.speed * deltaTime;
    
    // Быстрая проверка на истечение времени жизни или потерю цели
    if (!bullet.shooter || !bullet.target || bullet.lifetime <= 0) {
      if (bullet.isMissile || bullet.isArtillery) applySplashDamage(bullet);
      releaseBulletToPool(bullet);
      gameState.bullets.splice(i, 1);
      continue;
    }

    // Оптимизированный поиск коллизий через Quadtree (ВМЕСТО .filter)
    const range = 10;
    const queryRect = { x: bullet.x - range, y: bullet.y - range, width: range * 2, height: range * 2 };
    const candidates = quadtree ? quadtree.query(queryRect) : [];
    let hit = false;

 for (let j = 0; j < candidates.length; j++) {
   let target = candidates[j];
   if (!target || target === bullet.shooter) continue;
   if (target.owner === bullet.shooter.owner || !(target.health > 0) || target.destroyed) continue;
   hit = true;
   fxApplyDamage(target, bullet.damage, bullet.shooter);   // 🔥 урон РОВНО один раз
   if (bullet.isMissile || bullet.isArtillery) {
     applySplashDamage(bullet);
   } else {
     spawnSparkEffect(bullet.x, bullet.y);
   }
   break; // Пуля поражает первую цель и исчезает
 }

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
// Токены ресурсов (визуальное отображение переносимого ресурса)
function spawnResourceToken(worker, resourceType) {
  const token = {
    type: "resourceToken",
    resourceType: resourceType,
    offsetX: 1,
    offsetY: -2,
    x: worker.x + 10,
    y: worker.y - 5
  };
  worker.carriedResourceToken = token;
}

function startWorkerCycle(worker, warehouse) {
  // 🔥 ИСПРАВЛЕНИЕ: Если нейросеть дала рабочему боевую команду — отменяем её
  if (worker.commandQueue && worker.commandQueue.length > 0) {
    const hasForeignCommand = worker.commandQueue.some(cmd => 
      cmd.type === "attack" || 
      (cmd.type === "move" && !worker.assignedResource) // move не к ресурсу = чужеродный
    );
    if (hasForeignCommand) {
      worker.commandQueue = [];
      worker.target = null;
      worker.defending = false;
      if (worker.currentMovementAnimation) {
        cancelAnimationFrame(worker.currentMovementAnimation);
        worker.currentMovementAnimation = null;
      }
    }
  }

  // 🏠 Проверка склада
  if (
    !worker.homeWarehouse ||
    gameState.buildings.indexOf(worker.homeWarehouse) === -1 ||
    worker.homeWarehouse.type !== "warehouse" ||
    !worker.homeWarehouse.active
  ) {
    worker.homeWarehouse = findNearestDeliveryBuilding(worker.x, worker.y, worker.owner);
  }

  // 🚚 Если рабочий несёт ресурс — доставляем
  if (worker.carrying > 0) {
    if (worker.delivering) {
      // Если уже в процессе доставки, просто ждём (не возвращаемся)
      return;
    }
    
    worker.delivering = true;
    worker.lastDeliveryStart = performance.now();

    let deliveryBuilding;
    if (worker.homeWarehouse && gameState.buildings.indexOf(worker.homeWarehouse) !== -1) {
      deliveryBuilding = worker.homeWarehouse;
    } else {
      deliveryBuilding = findNearestDeliveryBuilding(worker.x, worker.y, worker.owner);
    }

    if (deliveryBuilding) {
      if ((deliveryBuilding.currentDeliveryWorkers || 0) >= deliveryBuilding.maxDeliveryWorkers) {
        // Склад переполнен, ждём
        worker.delivering = false;
        setTimeout(() => startWorkerCycle(worker, warehouse), 1000);
        return;
      }

      deliveryBuilding.currentDeliveryWorkers = (deliveryBuilding.currentDeliveryWorkers || 0) + 1;

      moveUnit(worker, deliveryBuilding.x, deliveryBuilding.y, () => {
        if (worker.carriedResourceToken) {
          worker.carriedResourceToken = null;
        }
        deliveryBuilding.lidOpenUntil = performance.now() + 400;
        const resType = worker.assignedResourceType || "gold";
        const ownerRes = (worker.owner === playerId) ? gameState.playerResources : gameState.aiResources;
        ownerRes[resType] += worker.carrying;
        worker.carrying = 0;
        worker.delivering = false;
        deliveryBuilding.currentDeliveryWorkers--;
        worker.assignedResourceType = null;
        setTimeout(() => startWorkerCycle(worker, warehouse), 500);
      });
    } else {
      worker.delivering = false;
      setTimeout(() => startWorkerCycle(worker, warehouse), 500);
    }
    return;
  }

  // ⚖️ Назначение типа ресурса по наименьшей загрузке
      // ⚖️ УМНОЕ НАЗНАЧЕНИЕ РЕСУРСА: Баланс "сколько в казне" vs "сколько рабочих"
      if (!worker.assignedResourceType) {
        const types = ["gold", "silicon", "plasma"];
        const available = types.filter(type =>
          gameState.resources.some(r => !r.depleted && r.type === type)
        );
        
        if (available.length === 0) {
          setTimeout(() => startWorkerCycle(worker, warehouse), 3000);
          return;
        }

        // Определяем, чей это рабочий, чтобы смотреть правильную казну
        const res = worker.owner === playerId ? gameState.playerResources : gameState.aiResources;
        const resourceScores = {};
        
        available.forEach(type => {
          // 1. Сколько этого ресурса сейчас в казне
          const treasuryAmount = res[type] || 0;
          
          // 2. Сколько рабочих УЖЕ добывает этот тип
          const workersCount = gameState.units.filter(u => 
            u.type === "worker" && u.assignedResourceType === type
          ).length;
          
          // 3. ФОРМУЛА ПРИОРИТЕТА: (Ресурс в казне) / (Рабочие + 1)
          // +1 предотвращает деление на ноль и дает шанс новому рабочему
          resourceScores[type] = treasuryAmount / (workersCount + 1);
        });

        // 4. Сортируем: сначала идет тот ресурс, у которого НАИМЕНЬШИЙ приоритет (его меньше всего)
        available.sort((a, b) => resourceScores[a] - resourceScores[b]);
        
        // 5. ПОРОГ ПЕРЕКЛЮЧЕНИЯ: Если разница между самым отстающим и следующим больше 10 единиц,
        // мы принудительно направляем рабочего на отстающий ресурс.
        if (available.length >= 2) {
          const diff = resourceScores[available[1]] - resourceScores[available[0]];
          if (diff > 10) { 
            worker.assignedResourceType = available[0]; // Берем самый отстающий
          } else {
            // Иначе распределяем равномерно, чтобы не было простоя
            const countByType = {};
            types.forEach(t => {
              countByType[t] = gameState.units.filter(u => u.type === "worker" && u.assignedResourceType === t).length;
            });
            const minCount = Math.min(...available.map(t => countByType[t]));
            worker.assignedResourceType = available.filter(t => countByType[t] === minCount)[0];
          }
        } else {
          worker.assignedResourceType = available[0];
        }
      }

  const type = worker.assignedResourceType;

  // 🔎 Ищем ресурсы
  const allResources = gameState.resources.filter(r =>
    r.type === type && !r.depleted
  );

  if (allResources.length === 0) {
    worker.assignedResourceType = null;
    setTimeout(() => startWorkerCycle(worker, warehouse), 1000);
    return;
  }

  allResources.sort((a, b) =>
    Math.hypot(a.x - worker.x, a.y - worker.y) - Math.hypot(b.x - worker.x, b.y - worker.y)
  );

  const nearestResource = allResources[0];

  if (nearestResource.currentWorkers >= nearestResource.maxWorkers) {
    worker.assignedResource = null;
    setTimeout(() => startWorkerCycle(worker, warehouse), 1000);
    return;
  }

  nearestResource.currentWorkers++;
  worker.assignedResource = nearestResource;

  moveUnit(worker, nearestResource.x, nearestResource.y, () => {
    setTimeout(() => {
      if (nearestResource.amount > 0) {
        nearestResource.amount--;
        worker.carrying = (worker.carrying || 0) + 5;
        if (!worker.carriedResourceToken) {
          spawnResourceToken(worker, type);
        }
        spawnSparkEffect(nearestResource.x, nearestResource.y);
      }
      nearestResource.currentWorkers--;
      worker.assignedResource = null;
      startWorkerCycle(worker, warehouse);
    }, 2000);
  });
}

function startTurretCycle(turret) {
  turret.lastFireTime = 0; turret.active = true;
  function cycle() {
    if (!turret.active || turret.health <= 0) return;
    if (!turret.target || turret.target.health <= 0 || (Math.hypot(turret.target.x - turret.x, turret.target.y - turret.y) > turret.range)) {
      const candidates = getEnemiesInRange({ x: turret.x, y: turret.y }, turret.range, turret.owner);
      turret.target = candidates.length > 0 ? candidates[0] : null;
    }
    if (turret.target) {
      const now = performance.now();
      if (now - turret.lastFireTime >= turret.fireRate) { fireBullet(turret, turret.target); turret.lastFireTime = now; }
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
// Продажа зданий / очередь продаж ИИ
window.aiSaleQueue = window.aiSaleQueue || [];
window.aiSaleCooldown = window.aiSaleCooldown || false;
window.soldBuildings = window.soldBuildings || [];

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
// Обработка очереди производства юнитов
let unitIdCounter = 0;
function generateUniqueUnitId() {
  // 🔥 Используем комбинацию счётчика, времени и случайного числа
  const uniqueId = 'unit_' + (unitIdCounter++) + '_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  return uniqueId;
}

function processProductionQueue(building) {
  if (!building) return;
  if (!building.productionQueue || building.productionQueue.length === 0) return;
  if (!building.active) return;

  const order = building.productionQueue[0];
  const now = performance.now();

  if (now >= order.timeStart + order.productionTime) {
    // Производство завершено
    building.productionQueue.shift();

    const { spawn, target } = spawnAtBoundary(building, 10);
    const unit = getUnitFromPool(order.unitType, building.owner, spawn.x, spawn.y);

    unit.id = generateUniqueUnitId(); // Уникальный ID для синхронизации
    addUnit(unit);
    moveUnit(unit, target.x, target.y);

    if (unit.type === "worker") {
      unit.homeWarehouse = building;
      startWorkerCycle(unit, building);
    } else if (unit.type === "repairman") {
      unit.homeWorkshop = building;
      startRepairmanCycle(unit);
    } else if (unit.type === "fighter") {
      startFighterCycle(unit);
    } else if (unit.type === "assault" || unit.type === "elite") {
      startAssaultEliteCycle(unit);
    }

    // === 🔁 Синхронизация в PvP: только если игрок создаёт
    if (gameMode === "pvp" && building.owner === playerId) {
      sendPvpAction({
        type: "hire",
        unitType: order.unitType,
        playerId: playerId,
        x: unit.x,
        y: unit.y,
        unitId: unit.id
      });
    }
  }
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
  // Обновляем квадродерево
  quadtree.clear();
  gameState.buildings.forEach(b => quadtree.insert(b));
  gameState.units.forEach(u => quadtree.insert(u));
  gameState.resources.forEach(r => quadtree.insert(r));

  // Обновляем токены ресурсов
  gameState.resourceTokens = [];
  gameState.units.forEach(unit => {
    if (unit.type === "worker" && unit.carriedResourceToken) {
      updateWorkerResourceToken(unit);
      gameState.resourceTokens.push(unit.carriedResourceToken);
    }
  });
}

function updateWorkerResourceToken(worker) {
  if (worker.carriedResourceToken) {
    const token = worker.carriedResourceToken;
    token.x = worker.x + token.offsetX;
    token.y = worker.y + token.offsetY;
  }
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
  updateFragments(deltaTime);
  updateParticles(deltaTime);
  updateFogOfWar();
  quadtree.clear();
  gameState.buildings.forEach(b => quadtree.insert(b));
  gameState.units.forEach(u => quadtree.insert(u));
  gameState.resources.forEach(r => quadtree.insert(r));
  updateBullets(deltaTime);
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

function getRandomBasePosition(margin, existingBase = null) {
  let pos, valid = false;
  while (!valid) {
    const side = Math.floor(Math.random() * 4);
    let x, y;
    switch (side) {
      case 0: x = margin + Math.random() * (worldWidth - 2 * margin); y = margin; break;
      case 1: x = worldWidth - margin; y = margin + Math.random() * (worldHeight - 2 * margin); break;
      case 2: x = margin + Math.random() * (worldWidth - 2 * margin); y = worldHeight - margin; break;
      case 3: x = margin; y = margin + Math.random() * (worldHeight - 2 * margin); break;
    }
    pos = { x, y };
    if (existingBase) {
      const dist = Math.hypot(pos.x - existingBase.x, pos.y - existingBase.y);
      if (dist >= worldWidth * 0.6) valid = true;
    } else { valid = true; }
  }
  return pos;
}

function createCapturePointsForBase(base) {
  const edgeMargin = 10, centerMargin = 30, halfWidth = worldWidth / 2;
  let xMin, xMax;
  const isLeftSide = base.owner === playerId;
  if (isLeftSide) { xMin = edgeMargin; xMax = halfWidth - centerMargin; } 
  else { xMin = halfWidth + centerMargin; xMax = worldWidth - edgeMargin; }
  const yMin = edgeMargin, yMax = worldHeight - edgeMargin;
  const pts = [];
  for(let i=0; i<4; i++) pts.push({ x: xMin + Math.random() * (xMax - xMin), y: yMin + Math.random() * (yMax - yMin) });
  return pts;
}

function startAssaultEliteCycle(unit) {
  if (!unit) return;
  // 🛡️ Каждая новая "жизнь" юнита получает новый epoch.
  // Когда юнит умрёт и будет выдан из пула заново, fxResetTransient сбросит __epoch,
  // и старый requestAnimationFrame умрёт сам.
  const epoch = (unit.__epoch = (unit.__epoch || 0) + 1);
  function cycle() {
    if ((unit.__epoch || 0) !== epoch) { FX_STATE.stats.zombie++; return; }
    if (unit.health <= 0 || !gameState.units.includes(unit)) return;
    if (unit.isRetreating) {
      requestAnimationFrame(cycle);
      return;
    }
    if (unit.commandQueue && unit.commandQueue.length > 0) {
      processCommandQueue(unit);
      requestAnimationFrame(cycle);
      return;
    }
    if (unit.target && unit.target.health > 0) {
      if (unit.type === "assault") {
        dynamicAttackAssault(unit, unit.target, 1/60);
      } else if (unit.type === "elite") {
        dynamicAttackElite(unit, unit.target, 1/60);
      }
    } else {
      let enemies = getEnemiesInRange({ x: unit.x, y: unit.y }, unit.range)
                    .filter(e => e.owner !== unit.owner && e.health > 0);
      if (enemies.length > 0) {
        unit.target = enemies.sort((a, b) =>
          Math.hypot(a.x - unit.x, a.y - unit.y) - Math.hypot(b.x - unit.x, b.y - unit.y)
        )[0];
      }
    }
    requestAnimationFrame(cycle);
  }
  cycle();
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

function recallRepairmenFromWorkshop(workshop) {
  const recalledRepairmen = gameState.units.filter(u =>
    u.owner === playerId &&
    u.type === "repairman" &&
    u.hidden && u.inWorkshop === workshop
  );

  if (recalledRepairmen.length > 0) {
    recalledRepairmen.forEach(u => {
      if (u.currentMovementAnimation) {
        cancelAnimationFrame(u.currentMovementAnimation);
        u.currentMovementAnimation = null;
      }
      if (u.waitingAnimation) {
        cancelAnimationFrame(u.waitingAnimation);
        u.waitingAnimation = null;
      }

      const exitOffset = 20;
      const angle = Math.random() * Math.PI * 2;
      const exitX = workshop.x + exitOffset * Math.cos(angle);
      const exitY = workshop.y + exitOffset * Math.sin(angle);

      animateMoveAndScale(u, exitX, exitY, 1, 500, () => {
        u.hidden = false;
        u.inWorkshop = null;
      });
    });
  } else {
    hireRepairmanForPlayer(workshop);
  }
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

function findNearestDeliveryBuilding(x, y, owner) {
  const queryRadius = 500;
  const candidates = getObjectsInRange({ x: x, y: y }, queryRadius).filter(b => b.owner === owner && b.type === "warehouse" && (b.currentDeliveryWorkers || 0) < b.maxDeliveryWorkers);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
  return candidates[0];
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

function generateResources(countPerType = 50, seed = 777) {
  const rand = seededRandom(seed);
  const resourceTypes = ["gold", "silicon", "plasma"];
  
  resourceTypes.forEach(type => {
    // 🔥 ИСПРАВЛЕНО: теперь количество берется из параметра countPerType, а не захардкожено!
    for (let i = 0; i < countPerType; i++) {
      const x = rand() * (worldWidth - 20) + 10;
      const y = rand() * (worldHeight - 20) + 10;
      
      // Если вы также хотите изменить количество ресурса В ОДНОМ месторождении, меняйте цифры здесь:
      const max = type === "gold" ? 150 : type === "silicon" ? 100 : 75;
      
      gameState.resources.push(new Resource(type, x, y, max, max));
    }
  });
}

function getUnitFromPool(type, owner, x, y) {
if (!unitPools[type]) unitPools[type] = [];
// 🧹 Выкидываем из пула дубли и объекты, которые уже в игре
if (unitPools[type].length > 0) {
  const live = new Set(gameState.units), seen = new Set(), clean = [];
  for (const p of unitPools[type]) {
    if (!p || seen.has(p) || live.has(p)) { FX_STATE.stats.dupPool++; continue; }
    seen.add(p); clean.push(p);
  }
  unitPools[type] = clean;
}
const pool = unitPools[type];
let unit;
  
  if (pool.length > 0) {
    unit = pool.pop();
    // 🔥 ПОЛНЫЙ СБРОС ВСЕХ ПОЛЕЙ ЮНИТА
    unit.x = x;
    unit.y = y;
    unit.owner = owner;
    unit.alive = true;
    unit.hidden = false;
    unit.hiding = false;
    unit.inWorkshop = null;
    unit.target = null;
    unit.commandQueue = [];
    unit.defending = false;
    unit.group = undefined;
    unit.selected = false;
    unit.maneuvering = false;
    unit.formationBuff = null;
    unit.burning = false;
    unit.burnTime = 0;
    unit.burnDuration = 0;
    unit.shocked = false;
    unit.shockedUntil = 0;
    unit.frozen = false;
    unit.freezeTimer = 0;
    unit.idleTimer = 0;
    unit.idlePhase = undefined;
    unit.vx = 0;
    unit.vy = 0;
    unit.angle = 0;
    unit.scale = 1;
    unit.carrying = 0;
    unit.delivering = false;
    unit.carriedResourceToken = null;
    unit.assignedResource = null;
    unit.assignedResourceType = null;
    unit.homeWarehouse = null;
    unit.homeWorkshop = null;
    unit.homeBuilding = null;
    unit.busyRepair = false;
    unit.laserBeam = null;
    unit.lastFireTime = 0;
    unit.lastMachineGunFireTime = 0;
    unit.lastRocketFireTime = 0;
    unit.lastMeleeAttack = 0;
    unit.lastArtilleryAttack = 0;
    unit.lastLaserAttack = 0;
    unit.attackCooldown = 0;
    unit.damage = undefined; // Сбрасываем бафф урона от формации
    unit.speed = undefined;  // Сбрасываем бафф скорости
    
    // 🔥 ПЕРЕСЧЁТ ХАРАКТЕРИСТИК ПО ТИПУ (критично!)
    switch (type) {
      case "worker":
        unit.health = 100; unit.maxHealth = 100;
        unit.visionRadius = VISION_RADIUS;
        break;
      case "fighter":
        unit.health = 250; unit.maxHealth = 250;
        unit.range = 180; unit.fireRate = 350;
        unit.orbitRadius = undefined; unit.orbitAngle = undefined;
        unit.engagementRadius = 500;
        unit.visionRadius = FIGHTER_VISION_RANGE;
        unit.strafeDirection = Math.random() > 0.5 ? 1 : -1;
        unit.strafeTimer = Math.random() * 2000 + 1000;
        unit.strafeInterval = Math.random() * 2000 + 1000;
        unit.orbitPhase = Math.random() * Math.PI * 2;
        // 🔥 НОВОЕ: Поля для рывка (прорыв в тыл)
        unit.dashTimer = Math.random() * 4000 + 4000; // Первый рывок через 4-8 сек
        unit.orbitDirection = Math.random() > 0.5 ? 1 : -1; // 🔥 Индивидуальное направление орбиты
        unit.dashInterval = Math.random() * 4000 + 4000; // Интервал между рывками
        unit.isDashing = false;
        unit.dashEndTime = 0;
        unit.dashVector = { x: 0, y: 0 };
        break;
      case "repairman":
        unit.health = 150; unit.maxHealth = 150;
        unit.engagementRadius = 500;
        unit.scale = 0.4;
        unit.visionRadius = VISION_RADIUS;
        break;
      case "assault":
        unit.health = 300; unit.maxHealth = 300;
        unit.machineGunRange = 200;
        unit.machineGunFireRate = 250;
        unit.rocketRange = 280;
        unit.rocketCooldown = 3000;
        unit.engagementRadius = 500;
        unit.range = 280;
        unit.visionRadius = ASSAULT_VISION_RANGE;
        unit.strafeDirection = Math.random() > 0.5 ? 1 : -1;
        unit.strafeTimer = Math.random() * 3000 + 1000;
        unit.strafeInterval = Math.random() * 3000 + 1000;
        unit.combatPhase = 'approach'; // Начальная фаза: сближение
        unit.phaseTimer = 0;
        unit.figure8Phase = Math.random() * Math.PI * 2;
        unit.rocketBurstCount = 0;
        unit.rocketBurstTimer = 0;
        break;
      case "elite":
        unit.health = 750; unit.maxHealth = 750;
        unit.range = 500;
        unit.meleeRange = 200;
        unit.artilleryRange = 500;
        unit.laserRange = 300;
        unit.meleeCooldown = 1000;
        unit.artilleryCooldown = 10000;
        unit.laserCooldown = 5000;
        unit.visionRadius = ELITE_VISION_RANGE;
        break;
    }
    
 unit.id = generateUniqueUnitId();
} else {
unit = new Unit(type, owner, x, y);
}
// 🧹 Единая зачистка + гарантия боевых полей (лечит undefined → NaN)
fxResetTransient(unit);
fxEnsureCombat(unit);
unit.__inPool = false;
unit.__removed = false;
unit.__inGame = false;   // в игру юнита ставит addUnit — это шаг 3
return unit;
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
  selectedUnits.forEach(unit => {
    const nearestEnemyBuilding = findNearestEnemyBuilding(unit.x, unit.y);
    if (nearestEnemyBuilding) {
      
      // 🔥 КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: Игрок дал прямой приказ! 
      // Мы стираем любую "подвешенную" память, чтобы юнит не вернулся к старой задаче после этой атаки.
      unit.suspendedQueue = null;

      unit.commandQueue = [
        { type: "move", x: nearestEnemyBuilding.x, y: nearestEnemyBuilding.y }, 
        { type: "attack", target: nearestEnemyBuilding }
      ];
      unit.target = nearestEnemyBuilding;
      
      if (gameMode === "pvp") {
        sendPvpAction({ 
          type: "attack", 
          unitId: unit.id, 
          targetId: nearestEnemyBuilding.id, 
          x: nearestEnemyBuilding.x, 
          y: nearestEnemyBuilding.y 
        });
      }
    }
  });
}

function findNearestEnemyBuilding(x, y) {
  let enemyBuildings = gameState.buildings.filter(b => b.owner !== playerId);
  let nearestBuilding = null, minDistance = Infinity;
  enemyBuildings.forEach(building => {
    const distance = Math.hypot(building.x - x, building.y - y);
    if (distance < minDistance) { minDistance = distance; nearestBuilding = building; }
  });
  return nearestBuilding;
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
        if (unit.health <= 0) removeUnit(unit);
        else { unit.burning = true; unit.burnTime = performance.now(); unit.burnDuration = 5000; }
      }
    }
  });
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

  // 1. Приоритет: скрытые точки захвата
  if (Array.isArray(gameState.capturePoints)) {
    const hidden = gameState.capturePoints.find(p => {
      const col = Math.floor(p.x / FOG_CELL_SIZE), row = Math.floor(p.y / FOG_CELL_SIZE);
      return fogMap?.[row]?.[col] === 0;
    });
    if (hidden) { 
      unit.commandQueue = [{ type: "move", x: hidden.x, y: hidden.y }]; 
      return hidden; 
    }
  }
  
  // 2. Поиск ближайшей клетки тумана войны
  const startCol = Math.floor(unit.x / FOG_CELL_SIZE);
  const startRow = Math.floor(unit.y / FOG_CELL_SIZE);
  const maxRadius = 50;
  
  for (let r = 1; r < maxRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // Проверяем только периметр квадрата
        
        const col = startCol + dx, row = startRow + dy;
        if (fogMap?.[row]?.[col] === 0) {
          const x = col * FOG_CELL_SIZE + FOG_CELL_SIZE / 2;
          const y = row * FOG_CELL_SIZE + FOG_CELL_SIZE / 2;
          
          unit.commandQueue = [{ type: "move", x, y }]; 
          return { x, y };
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

function getResourcesByOwner(owner) {
  if (gameMode === "pvp") return owner === playerId ? gameState.playerResources : gameState.aiResources;
  return owner === "ai" ? gameState.aiResources : gameState.playerResources;
}

function getMissingResources(cost, owner) {
  const resources = gameMode === "pvp" ? gameState.playerResources : (owner === "ai" ? gameState.aiResources : gameState.playerResources);
  const reserved = getReservedResources(owner);
  return {
    gold: Math.max(0, cost.gold + reserved.gold - resources.gold),
    silicon: Math.max(0, cost.silicon + reserved.silicon - resources.silicon),
    plasma: Math.max(0, cost.plasma + reserved.plasma - resources.plasma)
  };
}