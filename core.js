let isPaused = false;
let lastTime = performance.now();
let gameLoopId;
let frameCounter = 0;
const frameSkipMobile = 2;
let swarmFrameCounter = 0;
let particleUpdateAccumulator = 0;
// 🔥 ОТЛАДКА: отслеживание коллизий ID
let idCollisionCount = 0;
const PARTICLE_UPDATE_INTERVAL = 0.033;

function addUnit(unit) {
  // 🔥 АВТОМАТИЧЕСКОЕ ПРИСВАИВАНИЕ ID, если его нет
  if (!unit.id || unit.id === undefined) {
    unit.id = generateUniqueUnitId();
  }
  
  // ПРОВЕРКА: нет ли уже юнита с таким ID?
  const existingUnit = gameState.units.find(u => u.id === unit.id);
  if (existingUnit) {
    console.warn(`[⚠️ ID COLLISION] Юнит с ID ${unit.id} уже существует! Генерируем новый...`);
    unit.id = generateUniqueUnitId();
  }
  
  gameState.units.push(unit);
  if (unit.type === "fighter" || unit.type === "assault" || unit.type === "elite") gameState.attackers.push(unit);
  if (unit.type === "repairman") gameState.repairmen.push(unit);
  if (unit.defending) gameState.defenders.push(unit);
}

function removeUnit(unit) {
  cleanupUnitState(unit);
  for (let key in unitGroups) unitGroups[key] = unitGroups[key].filter(u => u !== unit);
  if (gameMode === "pvp" && unit.owner === playerId) sendPvpAction({ type: "die", unitId: unit.id });
  spawnDestructionFragments(unit.x, unit.y, unit.width || 10, unit.height || 10, unit.type);
  
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

function dynamicMove(unit, target, deltaTime) {
  const dx = target.x - unit.x, dy = target.y - unit.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return;
  const desiredAngle = Math.atan2(dy, dx);
  unit.angle = lerpAngle(unit.angle, desiredAngle, 0.01);
  const frontDirX = Math.cos(unit.angle), frontDirY = Math.sin(unit.angle);
  const desiredDistance = target instanceof Building ? (Math.max(target.width, target.height) / 2) + 50 : (unit.desiredDistance || 100);
  const distanceError = distance - desiredDistance;
  const approachStrength = 1.1, orbitStrength = 1.1;
  const tanX = -frontDirY, tanY = frontDirX;
  let ax, ay;
  if (Math.abs(distanceError) < 1) { ax = tanX * orbitStrength; ay = tanY * orbitStrength; } 
  else { ax = frontDirX * distanceError * approachStrength + tanX * orbitStrength; ay = frontDirY * distanceError * approachStrength + tanY * orbitStrength; }
  if (typeof unit.vx !== 'number') unit.vx = 0;
  if (typeof unit.vy !== 'number') unit.vy = 0;
  unit.vx = unit.vx * 0.9 + ax * deltaTime; unit.vy = unit.vy * 0.9 + ay * deltaTime;
  const currentSpeed = Math.hypot(unit.vx, unit.vy);
  if (currentSpeed > 50) { unit.vx = (unit.vx / currentSpeed); unit.vy = (unit.vy / currentSpeed); }
  unit.x += unit.vx * deltaTime; unit.y += unit.vy * deltaTime;
}

function moveUnit(unit, targetX, targetY, callback, spreadDone = false) {
  if (unit.shocked) return;
  const startX = unit.x, startY = unit.y;
  const dx = targetX - startX, dy = targetY - startY;
  const distance = Math.hypot(dx, dy);
  if (distance < 5) { if (callback) callback(); return; }
  unit.angle = Math.atan2(dy, dx);
  const speed = unit.speed || WORKER_SPEED;
  const duration = distance / speed; 
  const startTime = performance.now();
  function animate() {
    const currentTime = performance.now();
    const elapsed = (currentTime - startTime) / 1000;
    const progress = Math.min(elapsed / duration, 1);
    if (unit.owner === "ai" && unit.type !== "worker" && unit.type !== "repairman") {
      const enemies = getEnemiesInRange({ x: unit.x, y: unit.y }, unit.range || 150).filter(e => e.owner !== unit.owner);
      if (enemies.length > 0) {
        unit.commandQueue = [];
        const nearestEnemy = enemies.reduce((prev, curr) => Math.hypot(curr.x - unit.x, curr.y - unit.y) < Math.hypot(prev.x - unit.x, prev.y - unit.y) ? curr : prev);
        unit.commandQueue.push({ type: "attack", target: nearestEnemy });
        if (unit.currentMovementAnimation) { cancelAnimationFrame(unit.currentMovementAnimation); unit.currentMovementAnimation = null; }
        return;
      }
    }
    unit.x = startX + dx * progress; unit.y = startY + dy * progress;
    if (progress < 1) { unit.currentMovementAnimation = requestAnimationFrame(animate); } 
    else { unit.currentMovementAnimation = null; if (callback) callback(); }
  }
  if (unit.currentMovementAnimation) { cancelAnimationFrame(unit.currentMovementAnimation); unit.currentMovementAnimation = null; }
  animate();
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
  
// 🔥 ЯВНЫЙ СБРОС ЦВЕТА ПЕРЕД УСТАНОВКОЙ НОВОГО
  bullet.color = null;
  bullet.isArtillery = false;
  bullet.isMelee = false;

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

function dynamicAttack(unit, target, deltaTime) {
  // 🔥 ИСПРАВЛЕНИЕ: Разделяем логику атаки по типам юнитов!
  if (unit.type === "elite") { 
    dynamicAttackElite(unit, target, deltaTime); 
    return; 
  }
  if (unit.type === "assault") { 
    dynamicAttackAssault(unit, target, deltaTime); 
    return; 
  }
  
  // Обычный fighter
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
    dynamicMove(unit, target, deltaTime);
  }
}

function dynamicAttackAssault(unit, target, deltaTime) {
  if (unit.health <= 0 || !target || target.health <= 0) { 
    unit.target = null; 
    return; 
  }
  
  const currentDistance = Math.hypot(target.x - unit.x, target.y - unit.y);
  if (currentDistance > unit.range) { 
    unit.target = null; 
    return; 
  }
  
  const now = performance.now();
  
  // Пулемет (ближний бой)
  if (currentDistance <= unit.machineGunRange && (now - unit.lastMachineGunFireTime >= unit.machineGunFireRate)) {
    fireBullet(unit, target); // Теперь fireBullet правильно определит конфигурацию
    unit.lastMachineGunFireTime = now;
  }
  
  // Ракеты (дальний бой)
  if (currentDistance <= unit.rocketRange && (now - unit.lastRocketFireTime >= unit.rocketCooldown)) {
    const targetAngle = Math.atan2(target.y - unit.y, target.x - unit.x);
    let rocket = new Bullet(unit.x, unit.y, targetAngle, MISSILE_CONFIG.speed, unit, target);
    rocket.lifetime = MISSILE_CONFIG.lifetime;
    rocket.damage = MISSILE_CONFIG.damage;
    rocket.splashRadius = MISSILE_CONFIG.splashRadius;
    rocket.splashDamage = MISSILE_CONFIG.splashDamage;
    rocket.isMissile = true;
    rocket.target = target;
    rocket.color = "255,0,0"; // Красный для ракет штурмовика
    gameState.bullets.push(rocket);
    unit.lastRocketFireTime = now;
  }
  
  dynamicMove(unit, target, deltaTime);
}

function dynamicAttackElite(unit, target, deltaTime) {
  if (unit.health <= 0 || !target || target.health <= 0) { 
    unit.target = null; 
    return; 
  }
  
  const currentDistance = Math.hypot(target.x - unit.x, target.y - unit.y);
  const preferredRange = unit.artilleryPreferredRange || unit.artilleryRange || 500;
  const now = performance.now();
  
  // Держим дистанцию
  if (currentDistance < preferredRange * 0.8) {
    const angleAway = Math.atan2(unit.y - target.y, unit.x - target.x);
    dynamicMove(unit, { x: target.x + Math.cos(angleAway) * preferredRange, y: target.y + Math.sin(angleAway) * preferredRange }, deltaTime);
  } else if (currentDistance > preferredRange * 1.2) {
    dynamicMove(unit, target, deltaTime);
  }
  
  // Ближний бой (дробовик)
  if (currentDistance <= unit.meleeRange && now - unit.lastMeleeAttack >= unit.meleeCooldown) {
    const desiredAngle = Math.atan2(target.y - unit.y, target.x - unit.x);
    const pelletCount = 7, spreadAngle = 30 * Math.PI / 180;
    for (let i = 0; i < pelletCount; i++) {
      const angleOffset = -spreadAngle / 2 + (spreadAngle * i) / (pelletCount - 1);
      let pellet = new Bullet(unit.x, unit.y, desiredAngle + angleOffset, MELEE_BULLET_CONFIG.speed, unit, target);
      pellet.lifetime = MELEE_BULLET_CONFIG.lifetime;
      pellet.damage = MELEE_BULLET_CONFIG.damage;
      pellet.isMelee = true;
      pellet.color = "255,165,0"; // Оранжевый для элиты
      gameState.bullets.push(pellet);
    }
    unit.lastMeleeAttack = now;
  }
  
  // Артиллерия (дальний бой)
  if (currentDistance <= unit.artilleryRange && now - unit.lastArtilleryAttack >= unit.artilleryCooldown) {
    const desiredAngle = Math.atan2(target.y - unit.y, target.x - unit.x);
    const artilleryCount = 5 + Math.floor(Math.random() * 6);
    for (let i = 0; i < artilleryCount; i++) {
      let artillery = new Bullet(unit.x, unit.y, desiredAngle + (Math.random() - 0.5) * 0.2, ARTILLERY_BULLET_CONFIG.speed, unit, target);
      artillery.lifetime = ARTILLERY_BULLET_CONFIG.lifetime;
      artillery.damage = ARTILLERY_BULLET_CONFIG.damage;
      artillery.splashRadius = ARTILLERY_BULLET_CONFIG.splashRadius;
      artillery.splashDamage = ARTILLERY_BULLET_CONFIG.splashDamage;
      artillery.color = "0,255,0"; // Зеленый для артиллерии
      artillery.isArtillery = true;
      gameState.bullets.push(artillery);
    }
    unit.lastArtilleryAttack = now;
  }
  
  // Лазер
  if (currentDistance <= unit.laserRange && now - unit.lastLaserAttack >= unit.laserCooldown) {
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
              if (enemy instanceof Building) { 
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

function processCommandQueue(unit) {
  if (unit.shocked) { unit.commandQueue = []; return; }
  if (unit.commandQueue.length === 0) {
    if (unit.type === "fighter" && getEnemiesInRange({ x: unit.x, y: unit.y }, unit.range).filter(e => e.owner !== unit.owner && e.health > 0).length > 0) {
      requestAnimationFrame(function cycle() {
        if (unit.commandQueue.length === 0) {
          const targets = getEnemiesInRange({ x: unit.x, y: unit.y }, unit.range).filter(e => e.owner !== unit.owner && e.health > 0);
          if (targets.length > 0) {
            unit.target = unit.target && unit.target.health > 0 ? unit.target : targets[0];
            dynamicAttack(unit, unit.target, 1 / 60);
            requestAnimationFrame(cycle);
          }
        }
      });
    }
    return;
  }
  unit.maneuvering = false;
  const command = unit.commandQueue.shift();
  if (command.type === "move") {
    moveUnit(unit, command.x, command.y, () => { processCommandQueue(unit); });
  } else if (command.type === "attack") {
    const target = command.target;
    if (!target || typeof target.x !== "number" || typeof target.y !== "number" || target.health <= 0 || (!gameState.buildings.includes(target) && !gameState.units.includes(target))) {
      unit.commandQueue = []; unit.target = null; return;
    }
    unit.target = target;
    const dist = Math.hypot(unit.x - target.x, unit.y - target.y);
    if (unit.range && dist > unit.range) { moveUnit(unit, target.x, target.y, () => { processCommandQueue(unit); }); } 
    else { dynamicAttack(unit, target, 1 / 60); requestAnimationFrame(() => processCommandQueue(unit)); }
  } else if (command.type === "gather") {
    const resource = command.resource;
    if (!resource || typeof resource.x !== "number" || typeof resource.y !== "number") { processCommandQueue(unit); return; }
    moveUnit(unit, resource.x, resource.y, () => {
      if (resource.amount > 0) { resource.amount--; unit.carrying = (unit.carrying || 0) + 1; }
      const deliveryBuilding = findNearestDeliveryBuilding(unit.x, unit.y, unit.owner);
      if (deliveryBuilding) {
        moveUnit(unit, deliveryBuilding.x, deliveryBuilding.y, () => {
          if (unit.carrying > 0) {
            const res = unit.owner === playerId ? gameState.playerResources : gameState.aiResources;
            res[resource.type] += unit.carrying; unit.carrying = 0;
          }
          if (resource.amount > 0) unit.commandQueue.unshift({ type: "gather", resource });
          processCommandQueue(unit);
        });
      } else {
        if (resource.amount > 0) unit.commandQueue.unshift({ type: "gather", resource });
        processCommandQueue(unit);
      }
    });
  } else if (command.type === "repair") {
    const { workshop, target } = command;
    if (!workshop || !target) { unit.commandQueue = []; return; }
    if (unit.inWorkshop) {
      const angle = Math.random() * Math.PI * 2;
      animateMoveAndScale(unit, workshop.x + 20 * Math.cos(angle), workshop.y + 20 * Math.sin(angle), 1, 1000, () => {
        unit.hidden = false; unit.inWorkshop = null;
        moveUnit(unit, target.x, target.y, () => { startRepairProcess(unit, command); });
      });
    } else {
      const d = Math.hypot(unit.x - workshop.x, unit.y - workshop.y);
      if (d > 10) {
        moveUnit(unit, workshop.x, workshop.y, () => { moveUnit(unit, target.x, target.y, () => { startRepairProcess(unit, command); }); });
      } else { moveUnit(unit, target.x, target.y, () => { startRepairProcess(unit, command); }); }
    }
  }
}

function checkForEnemiesAndAttack(unit) {
  if (!unit || !unit.range) return;
  
  // 🔥 ФИКС: getEnemiesInRange уже фильтрует по owner, но проверим еще раз для надежности
  const enemiesInRange = getEnemiesInRange({ x: unit.x, y: unit.y }, unit.range)
    .filter(e => e.owner !== unit.owner && e.health > 0);
    
  if (enemiesInRange.length > 0) {
    // Если цель уже найдена и жива, не меняем её постоянно
    if (unit.target && unit.target.health > 0 && enemiesInRange.includes(unit.target)) {
      return; 
    }
    
    unit.commandQueue = [];
    // Сортируем по расстоянию и берем самого ближнего
    unit.target = enemiesInRange.sort((a, b) => 
      Math.hypot(a.x - unit.x, a.y - unit.y) - Math.hypot(b.x - unit.x, b.y - unit.y)
    )[0];
    
    unit.commandQueue.push({ type: "attack", target: unit.target });
  } else {
    // Если врагов нет, сбрасываем цель, чтобы юнит не стоял тупо
    if (unit.target) unit.target = null;
  }
}

function startRepairmanCycle(repairman) {
  let idleStartTime = performance.now();
  function loop() {
    if (!gameState.units.includes(repairman)) return;
    const isIdle = !repairman.busyRepair && repairman.commandQueue.length === 0;
    const isOutside = !repairman.hidden;
    if (isIdle) {
      const damaged = gameState.buildings.find(b => b.owner === repairman.owner && b.health < b.maxHealth && (!b.repairmen || b.repairmen.length < 3 || b.repairmen.includes(repairman)));
      if (damaged) {
        if (!damaged.repairmen) damaged.repairmen = [];
        if (!damaged.repairmen.includes(repairman)) damaged.repairmen.push(repairman);
        const distance = Math.hypot(damaged.x - repairman.x, damaged.y - repairman.y);
        if (distance > 10) { repairman.commandQueue = [{ type: "repair", target: damaged, workshop: repairman.homeWorkshop }]; processCommandQueue(repairman); } 
        else { startRepairProcess(repairman, { target: damaged, workshop: repairman.homeWorkshop }); }
        repairman.busyRepair = true;
      } else if (isOutside && performance.now() - idleStartTime > 5000) {
        const w = repairman.homeWorkshop;
        if (w) {
          animateMoveAndScale(repairman, w.x, w.y, 0.1, 700, () => { repairman.hidden = true; repairman.inWorkshop = w; });
        }
      }
    } else { idleStartTime = performance.now(); }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
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
    
    // Если есть приказ — исполняем
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



function updateUnits(deltaTime) {
  const now = performance.now();
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
  gameState.units.forEach(unit => {
    const isShocked = unit.shockedUntil && now < unit.shockedUntil;
    if (unit.burning) {
      const elapsed = now - unit.burnTime;
      if (elapsed < unit.burnDuration) {
        if (!unit.lastBurnTick || now - unit.lastBurnTick > 500) { unit.health -= 10; unit.lastBurnTick = now; spawnSparkEffect(unit.x, unit.y); }
      } else { unit.burning = false; }
    }
    if (isShocked && unit.owner === "ai") {
      if (!unit.lastShockEffect || now - unit.lastShockEffect > 500) { spawnShockEffect(unit.x, unit.y); unit.lastShockEffect = now; }
      unit.shocked = true; unit.commandQueue = []; unit.target = null; return;
    } else { unit.shocked = false; }
    if (unit.type === "elite" && unit.target && unit.health > 0 && !unit.shocked) { dynamicAttackElite(unit, unit.target, deltaTime); } 
    else if (unit.type === "assault" && unit.target && unit.health > 0 && !unit.shocked) { dynamicAttackAssault(unit, unit.target, deltaTime); } 
    else if (unit.type === "fighter" && unit.target && unit.health > 0 && !unit.shocked) { dynamicAttack(unit, unit.target, deltaTime); } 
    else { unit.idleTimer += deltaTime; }
  });
  gameState.units = gameState.units.filter(unit => {
    if (unit.health <= 0) { removeUnit(unit); return false; }
    return true;
  });
  swarmFrameCounter++;
  if (swarmFrameCounter % 5 === 0) updateSwarmBehavior(deltaTime);
  if (swarmFrameCounter > 1000) swarmFrameCounter = 0;
}

// === ШАГ 2: ОПТИМИЗИРОВАННЫЙ ГОРЯЧИЙ ЦИКЛ ПУЛЬ ===
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
      if (target.owner !== bullet.shooter.owner && target.health > 0) {
        target.health -= bullet.damage;
	    if (typeof onDamage === "function") onDamage(target, bullet.damage);
        hit = true;
        
        if (bullet.isMissile || bullet.isArtillery) {
          applySplashDamage(bullet);
        } else {
          spawnSparkEffect(bullet.x, bullet.y);
        }

        if (target.health <= 0) {
          spawnDestructionFragments(target.x, target.y, target.width || 10, target.height || 10, target.type);
          if (target instanceof Building) onBuildingDestroyed(target);
          else removeUnit(target);
        }
        break; // Пуля поражает первую цель и исчезает
      }
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
  spawnExplosionEffect(bullet.x, bullet.y);
  const queryRect = { 
    x: bullet.x - bullet.splashRadius, 
    y: bullet.y - bullet.splashRadius, 
    width: bullet.splashRadius * 2, 
    height: bullet.splashRadius * 2 
  };
  const candidates = quadtree ? quadtree.query(queryRect) : [];
  
  for (let i = 0; i < candidates.length; i++) {
    let obj = candidates[i];
    if (obj.owner !== bullet.shooter.owner && obj.health > 0 && Math.hypot(obj.x - bullet.x, obj.y - bullet.y) <= bullet.splashRadius) {
      
      // 🔥 КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: вызываем onDamage вместо прямого вычитания!
      if (typeof onDamage === "function") {
        onDamage(obj, bullet.splashDamage);
      } else {
        // Fallback на случай, если onDamage вдруг не определен
        obj.health -= bullet.splashDamage;
        if (obj.health <= 0) {
          spawnDestructionFragments(obj.x, obj.y, obj.width || 10, obj.height || 10, obj.type);
          if (obj instanceof Building) {
            if (typeof onBuildingDestroyed === "function") onBuildingDestroyed(obj);
          } else {
            if (typeof removeUnit === "function") removeUnit(obj);
          }
        }
      }
    }
  }
}
// ==================================================

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



// ============================================================
// Токены ресурсов (визуальное отображение переносимого ресурса)
// ============================================================

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

function updateWorkerResourceToken(worker) {
  if (worker.carriedResourceToken) {
    const token = worker.carriedResourceToken;
    token.x = worker.x + token.offsetX;
    token.y = worker.y + token.offsetY;
  }
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

function startFighterCycle(fighter) {
  if (!fighter) return;
  function cycle() {
    if (fighter.health <= 0) return;
    if (fighter.commandQueue.length > 0) { processCommandQueue(fighter); requestAnimationFrame(cycle); return; }
    if (fighter.target && fighter.target.health > 0) { dynamicAttack(fighter, fighter.target, 1/60); } 
    else {
      let enemies = getEnemiesInRange({ x: fighter.x, y: fighter.y }, fighter.range).filter(e => e.owner !== fighter.owner && e.health > 0);
      if (enemies.length > 0) fighter.target = enemies.sort((a, b) => Math.hypot(a.x - fighter.x, a.y - fighter.y) - Math.hypot(b.x - fighter.x, b.y - fighter.y))[0];
    }
    requestAnimationFrame(cycle);
  }
  cycle();
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
  gameState.units = gameState.units.filter(unit => {
    const isImportant = ['worker', 'repairman', 'fighter', 'assault', 'elite'].includes(unit.type);
    const isVisible = unit.x > screenLeft && unit.x < screenRight && unit.y > screenTop && unit.y < screenBottom;
    return isImportant || isVisible;
  });
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

// ============================================================
// Продажа зданий / очередь продаж ИИ
// ============================================================

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

// Очередь продаж обрабатывает AIScheduler

// ============================================================
// Обработка очереди производства юнитов
// ============================================================

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
  gameState.units.filter(unit => unit.owner === playerId && ["fighter", "assault", "elite"].includes(unit.type)).forEach(unit => checkForEnemiesAndAttack(unit));
  updateGameState(deltaTime);
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

function spawnWaveFromCapturePoint(cp) {
  const side = cp.owner;
  if (!side) return;
  let enemyTarget = gameMode === "single" ? (side === "player" ? aiBase : playerBase) : gameState.buildings.find(b => b.type.startsWith("base") && b.owner !== side);
  const spawnCenter = { x: cp.x, y: cp.y }, spawnRadius = 50;
  function getRandomSpawnPos(center) {
    const angle = Math.random() * Math.PI * 2, distance = Math.random() * spawnRadius;
    return { x: center.x + distance * Math.cos(angle), y: center.y + distance * Math.sin(angle) };
  }
  for (let i = 0; i < 2; i++) {
    const pos = getRandomSpawnPos(spawnCenter);
    const fighter = new Unit("fighter", side, pos.x, pos.y);
    gameState.units.push(fighter); startFighterCycle(fighter);
    if (enemyTarget) fighter.commandQueue.push({ type: "attack", target: enemyTarget });
  }
  for (let i = 0; i < 1; i++) {
    const pos = getRandomSpawnPos(spawnCenter);
    const assault = new Unit("assault", side, pos.x, pos.y);
    gameState.units.push(assault); startAssaultEliteCycle(assault);
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
  const recalledRepairmen = gameState.units.filter(u => u.owner === playerId && u.type === "repairman" && u.hidden && u.inWorkshop === workshop);
  if (recalledRepairmen.length > 0) {
    recalledRepairmen.forEach(u => {
      if (u.currentMovementAnimation) { cancelAnimationFrame(u.currentMovementAnimation); u.currentMovementAnimation = null; }
      if (u.waitingAnimation) { cancelAnimationFrame(u.waitingAnimation); u.waitingAnimation = null; }
      const exitOffset = 20, angle = Math.random() * Math.PI * 2;
      animateMoveAndScale(u, workshop.x + exitOffset * Math.cos(angle), workshop.y + exitOffset * Math.sin(angle), 1, 500, () => { u.hidden = false; u.inWorkshop = null; });
    });
  } else { hireRepairmanForPlayer(workshop); }
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

function generateResources(seed = 777) {
  const rand = seededRandom(seed);
  const resourceTypes = ["gold", "silicon", "plasma"];
  resourceTypes.forEach(type => {
    for (let i = 0; i < 100; i++) {
      const x = rand() * (worldWidth - 20) + 10, y = rand() * (worldHeight - 20) + 10;
      const max = type === "gold" ? 200 : type === "silicon" ? 150 : 100;
      gameState.resources.push(new Resource(type, x, y, max, max));
    }
  });
}

function getUnitFromPool(type, owner, x, y) {
  if (!unitPools[type]) unitPools[type] = [];
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

const unitGroups = { group1: [], group2: [], group3: [] };

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
  selectedUnits.forEach(unit => {
    const nearestEnemyBuilding = findNearestEnemyBuilding(unit.x, unit.y);
    if (nearestEnemyBuilding) {
      unit.commandQueue = [{ type: "move", x: nearestEnemyBuilding.x, y: nearestEnemyBuilding.y }, { type: "attack", target: nearestEnemyBuilding }];
      unit.target = nearestEnemyBuilding;
      if (gameMode === "pvp") sendPvpAction({ type: "attack", unitId: unit.id, targetId: nearestEnemyBuilding.id, x: nearestEnemyBuilding.x, y: nearestEnemyBuilding.y });
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
  const myBase = playerBase || gameState.buildings.find(b => b.owner === playerId && b.type.startsWith("base"));
  if (!myBase) return;
  selectedUnits.forEach(unit => {
    unit.commandQueue = [{ type: "move", x: myBase.x, y: myBase.y }]; unit.defending = true;
    if (gameMode === "pvp") sendPvpAction({ type: "defend", unitId: unit.id, x: myBase.x, y: myBase.y });
  });
}

function applyBombDamage(x, y) {
  gameState.units.forEach(unit => {
    if (unit.owner !== playerId) {
      const dist = Math.hypot(unit.x - x, unit.y - y);
      if (dist <= bombRadius) {
        const damage = bombMaxDamage * (1 - dist / bombRadius);
        unit.health -= damage;
        if (unit.health <= 0) removeUnit(unit);
        else { unit.burning = true; unit.burnTime = performance.now(); unit.burnDuration = 5000; }
      }
    }
  });
}

function setFormation(type) {
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

// ============================================================
// ПЕРКИ: РАСШИРЕННАЯ ЛОГИКА С ВИЗУАЛОМ
// ============================================================

// Убедись, что эти переменные объявлены в начале файла или в script.js:
// let perkAwaitingTarget = false, shockActive = false, bombActive = false, reconActive = false;
// let perkCooldowns = [0, 0, 0], equippedPerks = [null, null, null];
// let reconConfirmCallback = null, reconCancelCallback = null;
// let shockZones = [], bombZones = [], reconZones = [];

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
        unit.health -= 30 * (1 - dist / 180);
        unit.shockedUntil = Math.max(unit.shockedUntil || 0, performance.now() + 3000);
        unit.commandQueue = []; unit.target = null;
      }
    }
  });
}

function applyBombEffect(x, y) {
  bombZones.push({ x, y, start: performance.now(), exploded: false, radius: 0, maxRadius: 140, warningTime: 2000 });
  setTimeout(() => {
    const zone = bombZones.find(z => Math.hypot(z.x - x, z.y - y) < 5);
    if (zone && !zone.exploded) {
      zone.exploded = true;
      gameState.units.forEach(unit => {
        if (unit.owner !== playerId) {
          const dist = Math.hypot(unit.x - x, unit.y - y);
          if (dist <= 140) {
            unit.health -= 200 * Math.pow(1 - dist / 140, 1.5);
            if (unit.health > 0) { unit.burning = true; unit.burnTime = performance.now(); unit.burnDuration = 4000; }
          }
        }
      });
      // Здесь вызывается spawnExplosionEffect, который уже есть в твоем коде
      if (typeof spawnExplosionEffect === "function") spawnExplosionEffect(x, y);
      setTimeout(() => { const idx = bombZones.indexOf(zone); if (idx !== -1) bombZones.splice(idx, 1); }, 1000);
    }
  }, 2000);
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
  if (Array.isArray(gameState.capturePoints)) {
    const hidden = gameState.capturePoints.find(p => {
      const col = Math.floor(p.x / FOG_CELL_SIZE), row = Math.floor(p.y / FOG_CELL_SIZE);
      return fogMap?.[row]?.[col] === 0;
    });
    if (hidden) { unit.commandQueue = [{ type: "move", x: hidden.x, y: hidden.y }]; unit.target = null; return hidden; }
  }
  const startCol = Math.floor(unit.x / FOG_CELL_SIZE), startRow = Math.floor(unit.y / FOG_CELL_SIZE), maxRadius = 50;
  for (let r = 1; r < maxRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const col = startCol + dx, row = startRow + dy;
        if (fogMap?.[row]?.[col] === 0) {
          const x = col * FOG_CELL_SIZE + FOG_CELL_SIZE / 2, y = row * FOG_CELL_SIZE + FOG_CELL_SIZE / 2;
          unit.commandQueue = [{ type: "move", x, y }]; unit.target = null; return { x, y };
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

