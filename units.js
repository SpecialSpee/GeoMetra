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
// 2. ЕДИНАЯ функция обновления позиции (вызывается из updateUnits каждый кадр)
function applyUnitMovement(unit, deltaTime) {
  if (unit.shocked || unit.health <= 0) return;

  // 🔥 ПРИОРИТЕТ 0: ОТСТУПЛЕНИЕ
  if (unit.isRetreating) {
    let target = unit.retreatTarget;
    
    // Проверяем валидность цели
    if (!target || target.health <= 0 || !target.active) {
      const workshops = gameState.buildings.filter(b => 
        b.owner === unit.owner && b.type === 'repairWorkshop' && b.active && b.health > 0
      );
      if (workshops.length > 0) {
        target = workshops.sort((a, b) => 
          Math.hypot(a.x - unit.x, a.y - unit.y) - Math.hypot(b.x - unit.x, b.y - unit.y)
        )[0];
        unit.retreatTarget = target;
      } else {
        target = unit.owner === "player" ? playerBase : aiBase;
        unit.retreatTarget = target;
      }
    }
    
    if (!target) {
      unit.isRetreating = false;
      unit.retreatTarget = null;
      unit.target = null;
      return;
    }
    
    // 🔥 НОВОЕ: ОТСТРЕЛ ВО ВРЕМЯ ОТСТУПЛЕНИЯ
    // Если враг в радиусе — стреляем, но НЕ переключаем цель и НЕ добавляем в очередь
    const nearbyEnemies = getEnemiesInRange({x: unit.x, y: unit.y}, unit.range)
      .filter(e => e.owner !== unit.owner && e.health > 0);
    
    if (nearbyEnemies.length > 0) {
      const nearestEnemy = nearbyEnemies.sort((a, b) =>
        Math.hypot(a.x - unit.x, a.y - unit.y) - Math.hypot(b.x - unit.x, b.y - unit.y)
      )[0];
      
      const now = performance.now();
      if (now - unit.lastFireTime >= unit.fireRate) {
        fireBullet(unit, nearestEnemy);
        unit.lastFireTime = now;
      }
    }
    
    const dist = Math.hypot(target.x - unit.x, target.y - unit.y);
    const arrivalThreshold = target.type === 'repairWorkshop' ? 40 : 25;
    
    if (dist > arrivalThreshold) {
      // Двигаемся к цели
      if (!unit.moveTarget || Math.hypot(unit.moveTarget.x - target.x, unit.moveTarget.y - target.y) > 10) {
          moveUnit(unit, target.x, target.y);
      }
      
      // 🔥 ВЫПОЛНЯЕМ ДВИЖЕНИЕ ПО WAYPOINTS ПРЯМО ЗДЕСЬ
      if (unit.moveTarget) {
        const dx = unit.moveTarget.x - unit.x;
        const dy = unit.moveTarget.y - unit.y;
        const d = Math.hypot(dx, dy);
        
        if (d < 15) {
          unit.currentWaypointIndex++;
          if (unit.pathWaypoints && unit.currentWaypointIndex < unit.pathWaypoints.length) {
            unit.moveTarget = unit.pathWaypoints[unit.currentWaypointIndex];
            unit.angle = Math.atan2(unit.moveTarget.y - unit.y, unit.moveTarget.x - unit.x);
          } else {
            unit.x = unit.moveTarget.x;
            unit.y = unit.moveTarget.y;
            unit.moveTarget = null;
            unit.pathWaypoints = null;
            unit.currentWaypointIndex = 0;
          }
        } else {
          unit.angle = Math.atan2(dy, dx);
          
          // 🔥 НЕСТАБИЛЬНАЯ СКОРОСТЬ ОТСТУПЛЕНИЯ (40-70% от обычной, эффект троющего двигателя)
          let baseSpeed = ["fighter", "assault", "elite"].includes(unit.type) ? 120 : WORKER_SPEED;
          // Используем unit.__epoch как уникальный числовой идентификатор юнита для синуса
          const fluctuation = Math.sin(performance.now() / 800 + (unit.__epoch || 0)) * 0.15; // ±15%
          const damageFactor = 0.55 + (unit.health / unit.maxHealth) * 0.15; // База 55-70% в зависимости от HP
          let retreatSpeed = baseSpeed * (damageFactor + fluctuation);
          retreatSpeed = Math.max(baseSpeed * 0.4, Math.min(baseSpeed * 0.7, retreatSpeed)); // Жесткое ограничение 40-70%
          
          const speed = retreatSpeed;
          
          unit.vx = (dx / d) * speed;
          unit.vy = (dy / d) * speed;
          
          unit.x += unit.vx * deltaTime;
          unit.y += unit.vy * deltaTime;
          
          // 🔥 ПРОВЕРКА КОЛЛИЗИЙ С КАМНЯМИ ДЛЯ ОТСТУПАЮЩИХ ЮНИТОВ
          if (typeof checkRockCollision === "function") {
            checkRockCollision(unit);
          }
        }
      }
    } else {
      // 🔥 МЫ ДОБРАЛИСЬ! Останавливаемся и ЖДЕМ лечения.
      unit.vx = 0;
      unit.vy = 0;
      unit.moveTarget = null;
      unit.pathWaypoints = null;
      unit.currentWaypointIndex = 0;
      unit.commandQueue = [];
      
      if (target.type === 'repairWorkshop' && unit.health < unit.maxHealth) {
        unit.health = Math.min(unit.maxHealth, unit.health + 0.8);
      }
    }
    
    // 🔥 КРИТИЧЕСКИ ВАЖНО: прерываем функцию, чтобы боевая физика НЕ перехватила управление!
    return;
  }

  // 🔥 ПРИОРИТЕТ 1: Боевая физика
  if (["fighter", "assault", "elite"].includes(unit.type) && unit.target && unit.target.health > 0) {
    const distToTarget = Math.hypot(unit.target.x - unit.x, unit.target.y - unit.y);
    
    if (unit.moveTarget && distToTarget > unit.range * 1.2) {
      // Пропускаем боевую физику, код пойдет дальше к ПРИОРИТЕТУ 2 (стандартное движение по A*)
    } else {
      // Юнит либо уже в радиусе атаки, либо потерял A* путь. Включаем боевую физику (орбита/стрейф).
      if (unit.type === "assault") {
        updateAssaultPhysics(unit, unit.target, deltaTime);
      } else if (unit.type === "fighter") {
        const mode = distToTarget > unit.range ? 'approach' : 'orbit';
        updateFighterPhysics(unit, unit.target, mode, deltaTime);
      } else if (unit.type === "elite") {
        updateElitePhysics(unit, unit.target, deltaTime);
      }
      return; // Выходим, боевая физика взяла управление
    }
  }

  // ПРИОРИТЕТ 2: Стандартное движение к точке (с поддержкой Waypoints)
  if (unit.moveTarget) {
    const dx = unit.moveTarget.x - unit.x;
    const dy = unit.moveTarget.y - unit.y;
    const dist = Math.hypot(dx, dy);
    
    if (dist < 15) {
      unit.currentWaypointIndex++;
      if (unit.pathWaypoints && unit.currentWaypointIndex < unit.pathWaypoints.length) {
        unit.moveTarget = unit.pathWaypoints[unit.currentWaypointIndex];
        unit.angle = Math.atan2(unit.moveTarget.y - unit.y, unit.moveTarget.x - unit.x);
      } else {
        unit.x = unit.moveTarget.x;
        unit.y = unit.moveTarget.y;
        const cb = unit.moveCallback;
        unit.moveTarget = null;
        unit.pathWaypoints = null;
        unit.currentWaypointIndex = 0;
        unit.moveCallback = null;
        if (typeof cb === "function") cb();
        return;
      }
    }

    unit.angle = Math.atan2(dy, dx);
    const speed = unit.speed || (["fighter", "assault", "elite"].includes(unit.type) ? 120 : WORKER_SPEED);
    
    let desiredVx = (dx / dist) * speed;
    let desiredVy = (dy / dist) * speed;
    
    unit.vx = desiredVx;
    unit.vy = desiredVy;
    
    applyLocalUnitAvoidance(unit);
    
    unit.x += unit.vx * deltaTime;
    unit.y += unit.vy * deltaTime;
    
    // 🔥 ДОБАВЛЯЕМ ПРОВЕРКУ КОЛЛИЗИЙ И СЮДА, чтобы обычные юниты тоже не пролетали сквозь камни
    if (typeof checkRockCollision === "function") {
      checkRockCollision(unit);
    }
  }
}
// 🔥 ЛОКАЛЬНОЕ ИЗБЕГАНИЕ ЮНИТ-ЮНИТ (работает поверх A*)
function applyLocalUnitAvoidance(unit) {
  const avoidRadius = 25; // Радиус, в котором юниты начинают расталкиваться
  const neighbors = getObjectsInRange({x: unit.x, y: unit.y}, avoidRadius)
    .filter(u => u !== unit && u instanceof Unit && u.health > 0);
    
  if (neighbors.length === 0) return;
  
  let pushX = 0, pushY = 0;
  for (const other of neighbors) {
    const dx = unit.x - other.x;
    const dy = unit.y - other.y;
    const dist = Math.hypot(dx, dy);
    
    if (dist < avoidRadius && dist > 0) {
      const force = (avoidRadius - dist) / avoidRadius; // Чем ближе, тем сильнее толчок
      pushX += (dx / dist) * force * 80; // Сила расталкивания
      pushY += (dy / dist) * force * 80;
    }
  }
  
  // Накладываем расталкивание на текущий вектор движения
  unit.vx += pushX * (1/60);
  unit.vy += pushY * (1/60);
  
  // Ограничиваем максимальную скорость, чтобы юнит не ускорялся от толчков
  const maxSpeed = unit.speed || 120;
  const currentSpeed = Math.hypot(unit.vx, unit.vy);
  if (currentSpeed > maxSpeed) {
    unit.vx = (unit.vx / currentSpeed) * maxSpeed;
    unit.vy = (unit.vy / currentSpeed) * maxSpeed;
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
  
  // 🔥 УНИВЕРСАЛЬНАЯ ПРОВЕРКА ЖИВОСТИ (для юнитов, зданий И ресурсов)
  const isTargetDead = !target || 
    (target.amount !== undefined ? (target.hp || 0) <= 0 : target.health <= 0);
  
  if (isTargetDead) {
    unit.target = null;
    unit.commandQueue.shift();
    processCommandQueue(unit);
    return;
  }
  
  unit.target = target;
  const dist = Math.hypot(unit.x - target.x, unit.y - target.y);
  
  if (["fighter", "assault", "elite"].includes(unit.type)) {
    if (dist <= unit.range) {
      // В радиусе поражения — атакуем
      unit.moveTarget = null;
      unit.moveCallback = null;
      if (unit.type === "elite") dynamicAttackElite(unit, target, overrideDelta || 1/60);
      else if (unit.type === "assault") dynamicAttackAssault(unit, target, overrideDelta || 1/60);
      else dynamicAttack(unit, target, overrideDelta || 1/60);
    } else {
      // 🔥 НОВОЕ: Вне радиуса поражения — подходим к цели!
      // (Для камня координаты target.x/y уже смещены к его краю в contextmenu)
      if (!unit.moveTarget || Math.hypot(unit.moveTarget.x - target.x, unit.moveTarget.y - target.y) > 15) {
        moveUnit(unit, target.x, target.y);
      }
    }
  } else {
    // Для не-военных юнитов (если вдруг)
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
  unit.angle = lerpAngle(unit.angle, angleToTarget, 0.15);

  const frontX = Math.cos(unit.angle), frontY = Math.sin(unit.angle);
  const tanX = -frontY, tanY = frontX;

  let ax = 0, ay = 0;

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
      unit.postDashTimer = 1.5;
    } else {
      ax = unit.dashVector.x * 3.0;
      ay = unit.dashVector.y * 3.0;
    }
  } else if (mode === 'orbit') {
    const wobble = Math.sin((performance.now() / 500) + (unit.orbitPhase || 0)) * 25;
    const idealDist = (unit.range * 0.75) + wobble;
    let distError = dist - idealDist;

    if (unit.postDashTimer > 0) {
      unit.postDashTimer -= deltaTime;
      distError = 0; 
      const decay = unit.postDashTimer / 1.5; 
      ax = (unit.dashVector.x * 0.3 * decay) + (tanX * 80.0 * (unit.orbitDirection || 1) * (unit.strafeDirection || 1));
      ay = (unit.dashVector.y * 0.3 * decay) + (tanY * 80.0 * (unit.orbitDirection || 1) * (unit.strafeDirection || 1));      
    } else {
      unit.strafeTimer -= deltaTime * 1000;
      if (unit.strafeTimer <= 0) {
        if (Math.random() < 0.7) {
          unit.strafeDirection = (unit.strafeDirection || 1) * -1;
          unit.vx += (tanX * (unit.strafeDirection || 1)) * 60; 
          unit.vy += (tanY * (unit.strafeDirection || 1)) * 60;
        }
        unit.strafeTimer = Math.random() * 3000 + 500;
      }
      const dir = (unit.orbitDirection || 1) * (unit.strafeDirection || 1);
      if (Math.abs(distError) < 40) {
        ax = frontX * distError * 2.0 + tanX * 80.0 * dir;
        ay = frontY * distError * 2.0 + tanY * 80.0 * dir;
      }
    }
  } else {
    const desiredDist = unit.range * 0.8;
    const distError = dist - desiredDist;
    ax = frontX * distError * 5.0 + tanX * 8.0 * (unit.orbitDirection || 1) * (unit.strafeDirection || 1);
    ay = frontY * distError * 5.0 + tanY * 8.0 * (unit.orbitDirection || 1) * (unit.strafeDirection || 1);
  }

  unit.vx = unit.vx * 0.90 + ax * deltaTime;
  unit.vy = unit.vy * 0.90 + ay * deltaTime;

  const maxSpeed = unit.isDashing ? 100 : 70;
  const curSpeed = Math.hypot(unit.vx, unit.vy);
  if (curSpeed > maxSpeed) {
    unit.vx = (unit.vx / curSpeed) * maxSpeed;
    unit.vy = (unit.vy / curSpeed) * maxSpeed;
  }

  unit.x += unit.vx * deltaTime;
  unit.y += unit.vy * deltaTime;

  checkRockCollision(unit); 
}
function updateAssaultPhysics(unit, target, deltaTime) {
  if (!target || !unit) return;

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
  unit.angle = lerpAngle(unit.angle, angleToTarget, 0.08);

  const frontX = Math.cos(unit.angle), frontY = Math.sin(unit.angle);
  const tanX = -frontY, tanY = frontX;

  let ax = 0, ay = 0;

  unit.phaseTimer -= deltaTime * 1000;
  if (unit.phaseTimer <= 0) {
    if (unit.combatPhase === 'approach') {
      unit.combatPhase = 'retreat';
      unit.phaseTimer = 3000;
      unit.rocketBurstCount = 0;
      unit.rocketBurstTimer = 0;
    } else if (unit.combatPhase === 'retreat') {
      unit.combatPhase = 'approach';
      unit.phaseTimer = Math.random() * 3000 + 3000;
      unit.figure8Phase = Math.random() * Math.PI * 2;
    }
  }

  if (unit.combatPhase === 'approach') {
    const approachSpeed = 600;
    const figure8Amplitude = 50;
    const figure8Frequency = 1.2;
    unit.figure8Phase += deltaTime * figure8Frequency;
    const figure8Offset = Math.sin(unit.figure8Phase) * figure8Amplitude;
    ax = frontX * approachSpeed + tanX * figure8Offset * 2.0;
    ay = frontY * approachSpeed + tanY * figure8Offset * 2.0;
  } else if (unit.combatPhase === 'retreat') {
    const retreatSpeed = 300;
    ax = -frontX * retreatSpeed;
    ay = -frontY * retreatSpeed;
    
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
        unit.rocketBurstTimer = 500;
        unit.lastRocketFireTime = performance.now();
      }
    }
  }

  unit.strafeTimer -= deltaTime * 1000;
  if (unit.strafeTimer <= 0) {
    if (Math.random() < 0.5) {
      unit.strafeDirection = (unit.strafeDirection || 1) * -1;
      unit.vx += (tanX * (unit.strafeDirection || 1)) * 30;
      unit.vy += (tanY * (unit.strafeDirection || 1)) * 30;
    }
    unit.strafeTimer = Math.random() * 4000 + 2000;
  }

  const dir = unit.strafeDirection || 1;
  ax += tanX * 120.0 * dir;
  ay += tanY * 120.0 * dir;

  unit.vx = unit.vx * 0.88 + ax * deltaTime;
  unit.vy = unit.vy * 0.88 + ay * deltaTime;

  const maxSpeed = 90;
  const curSpeed = Math.hypot(unit.vx, unit.vy);
  if (curSpeed > maxSpeed) {
    unit.vx = (unit.vx / curSpeed) * maxSpeed;
    unit.vy = (unit.vy / curSpeed) * maxSpeed;
  }

  unit.x += unit.vx * deltaTime;
  unit.y += unit.vy * deltaTime;

  checkRockCollision(unit); 
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
        const now = performance.now();
        if (!unit.lastShredTime || now - unit.lastShredTime > 5000) {
            desiredPhase = 'shred';
            unit.lastShredTime = now;
        } else {
            desiredPhase = 'burn';
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
            if (unit.postVolleyTimer && unit.postVolleyTimer > 0) {
                unit.postVolleyTimer -= deltaTime;
                ax -= frontX * 40; 
                ay -= frontY * 40;
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
            const escapeDist = MELEE_MAX + 60;
            const distError = dist - escapeDist;
            ax = -frontX * Math.abs(distError) * 1.0;
            ay = -frontY * Math.abs(distError) * 1.0;
            ax += tanX * 15 * (unit.orbitDirection || 1);
            ay += tanY * 15 * (unit.orbitDirection || 1);
            break;
        }
    }

    unit.vx = unit.vx * 0.97 + ax * deltaTime;
    unit.vy = unit.vy * 0.97 + ay * deltaTime;

    const maxSpeed = panicMode ? 45 : 30;
    const curSpeed = Math.hypot(unit.vx, unit.vy);
    if (curSpeed > maxSpeed) {
        unit.vx = (unit.vx / curSpeed) * maxSpeed;
        unit.vy = (unit.vy / curSpeed) * maxSpeed;
    }

    unit.x += unit.vx * deltaTime;
    unit.y += unit.vy * deltaTime;

    checkRockCollision(unit); 
}
// ЕДИНЫЙ ДВИЖОК ДВИЖЕНИЯ
function moveUnit(unit, targetX, targetY, callback) {
  // 🔥 ИСПРАВЛЕНО: Убрали unit.isRetreating из блокировки. 
  // Теперь отступающие юниты МОГУТ использовать A* pathfinding!
  if (unit.shocked || unit.health <= 0) return;
  
  if (unit.currentMovementAnimation) {
    cancelAnimationFrame(unit.currentMovementAnimation);
    unit.currentMovementAnimation = null;
  }

  // Рассчитываем путь через A*
  const rawPath = findPath(unit.x, unit.y, targetX, targetY);
  unit.pathWaypoints = simplifyPath(rawPath);
  unit.currentWaypointIndex = 0;
  unit.moveCallback = callback;
  
  // Если путь прямой (препятствий нет), сразу ставим цель
  if (unit.pathWaypoints.length <= 1) {
    unit.moveTarget = { x: targetX, y: targetY };
  } else {
    unit.moveTarget = unit.pathWaypoints[1]; // Идем к первой точке поворота
  }
  
  unit.angle = Math.atan2(unit.moveTarget.y - unit.y, unit.moveTarget.x - unit.x);
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
  if (unit.type === "elite") { dynamicAttackElite(unit, target, deltaTime); return; }
  if (unit.type === "assault") { dynamicAttackAssault(unit, target, deltaTime); return; }

  if (!target) { unit.target = null; return; }
  const isTargetDead = target.amount !== undefined ? (target.hp || 0) <= 0 : target.health <= 0;
  if (isTargetDead) { unit.target = null; return; }

  const currentDistance = Math.hypot(target.x - unit.x, target.y - unit.y);
  if (currentDistance > unit.range) { unit.target = null; return; }

  // 🔥 НОВОЕ: преграда = не стреляем (цель НЕ сбрасываем — юнит просто ждёт)
  if (isLineOfSightBlocked(unit.x, unit.y, target.x, target.y)) return;

  const now = performance.now();
  if (unit.type === "fighter") {
    if (unit.shocked) return;
    if (now - unit.lastFireTime >= unit.fireRate) {
      fireBullet(unit, target);
      unit.lastFireTime = now;
    }
  }
}
function dynamicAttackAssault(unit, target, deltaTime) {
  if (unit.health <= 0 || !target) { unit.target = null; return; }
  
  // 🔥 УНИВЕРСАЛЬНАЯ ПРОВЕРКА
  const isTargetDead = target.amount !== undefined 
    ? (target.hp || 0) <= 0 
    : target.health <= 0;
  if (isTargetDead) { unit.target = null; return; }
  
  const currentDistance = Math.hypot(target.x - unit.x, target.y - unit.y);
  const now = performance.now();

   if (isLineOfSightBlocked(unit.x, unit.y, target.x, target.y)) return;
  
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
  if (unit.health <= 0 || !target) { unit.target = null; return; }
  
  // 🔥 УНИВЕРСАЛЬНАЯ ПРОВЕРКА
  const isTargetDead = target.amount !== undefined 
    ? (target.hp || 0) <= 0 
    : target.health <= 0;
  if (isTargetDead) { unit.target = null; return; }

    const currentDistance = Math.hypot(target.x - unit.x, target.y - unit.y);
    const now = performance.now();

      // 🔥 НОВОЕ: LoS для арты/лазера (картечь ближнего боя не нужна — там упор)
    if (isLineOfSightBlocked(unit.x, unit.y, target.x, target.y) &&
        Math.hypot(target.x - unit.x, target.y - unit.y) > unit.meleeRange) {
      return;
    }
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
    .filter(e => 
      e.owner !== unit.owner && 
      e.health > 0 && 
      fxValidTarget(e) &&
      // 🔥 НОВАЯ ПРОВЕРКА: Враг должен быть на прямой видимости! (Теперь ВНУТРИ filter)
      (typeof isLineOfSightBlocked === "function" ? !isLineOfSightBlocked(unit.x, unit.y, e.x, e.y) : true)
    );

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
function startWorkerCycle(worker, warehouse) {
  // 🔥 1. ЖЁСТКАЯ ПРОВЕРКА: Если юнита нет в игре или он мёртв — прерываем цикл
  if (!worker || worker.health <= 0 || !gameState.units.includes(worker)) return;

  // 🔥 2. АНТИ-ЗАВИСАНИЕ: Сброс флагов, если движение прервалось внешним фактором
  if (worker.delivering && !worker.moveTarget && worker.commandQueue.length === 0) {
    worker.delivering = false;
    if (worker.assignedResource && worker.assignedResource.currentWorkers > 0) {
      worker.assignedResource.currentWorkers--;
    }
    worker.assignedResource = null;
  }

  // 🏠 Проверка склада
  if (!worker.homeWarehouse || !gameState.buildings.includes(worker.homeWarehouse) || !worker.homeWarehouse.active) {
    worker.homeWarehouse = findNearestDeliveryBuilding(worker.x, worker.y, worker.owner) || warehouse;
  }

  // 🚚 Если рабочий несёт ресурс — доставляем
  if (worker.carrying > 0) {
    if (worker.delivering) return; // Уже в пути, ждем завершения
    
    worker.delivering = true;
    let deliveryBuilding = worker.homeWarehouse && gameState.buildings.includes(worker.homeWarehouse) 
      ? worker.homeWarehouse 
      : findNearestDeliveryBuilding(worker.x, worker.y, worker.owner);

    if (deliveryBuilding && (deliveryBuilding.currentDeliveryWorkers || 0) < deliveryBuilding.maxDeliveryWorkers) {
      deliveryBuilding.currentDeliveryWorkers = (deliveryBuilding.currentDeliveryWorkers || 0) + 1;

      moveUnit(worker, deliveryBuilding.x, deliveryBuilding.y, () => {
        if (!gameState.units.includes(worker)) return; 

        if (worker.carriedResourceToken) worker.carriedResourceToken = null;
        if (deliveryBuilding) deliveryBuilding.lidOpenUntil = performance.now() + 400;
        
        const resType = worker.assignedResourceType || "gold";
        const ownerRes = (worker.owner === playerId) ? gameState.playerResources : gameState.aiResources;
        ownerRes[resType] += worker.carrying;
        
        worker.carrying = 0;
        worker.delivering = false; 
        if (deliveryBuilding) deliveryBuilding.currentDeliveryWorkers--;
        worker.assignedResourceType = null;
        
        setTimeout(() => startWorkerCycle(worker, warehouse), 500);
      });
    } else {
      worker.delivering = false;
      setTimeout(() => startWorkerCycle(worker, warehouse), 1000);
    }
    return;
  }

  // ⚖️ УМНОЕ НАЗНАЧЕНИЕ РЕСУРСА
  if (!worker.assignedResourceType) {
    const types = ["gold", "silicon", "plasma"];
    const available = types.filter(type => gameState.resources.some(r => !r.depleted && r.type === type));
    
    if (available.length === 0) {
      setTimeout(() => startWorkerCycle(worker, warehouse), 3000);
      return;
    }

    const res = worker.owner === playerId ? gameState.playerResources : gameState.aiResources;
    const resourceScores = {};
    
    available.forEach(type => {
      const treasuryAmount = res[type] || 0;
      const workersCount = gameState.units.filter(u => u.type === "worker" && u.assignedResourceType === type).length;
      resourceScores[type] = treasuryAmount / (workersCount + 1);
    });

    available.sort((a, b) => resourceScores[a] - resourceScores[b]);
    
    if (available.length >= 2 && (resourceScores[available[1]] - resourceScores[available[0]]) > 10) {
      worker.assignedResourceType = available[0];
    } else {
      const countByType = {};
      types.forEach(t => { countByType[t] = gameState.units.filter(u => u.type === "worker" && u.assignedResourceType === t).length; });
      const minCount = Math.min(...available.map(t => countByType[t]));
      worker.assignedResourceType = available.filter(t => countByType[t] === minCount)[0];
    }
  }

  // 🔥 3. ПРИОРИТЕТ: Сбор наземных осколков (С ЗАЩИТОЙ ОТ ДУБЛИКАЦИИ!)
  const groundTokens = (gameState.resourceTokens || []).filter(t => t.isGround);
  if (worker.carrying === 0 && groundTokens.length > 0) {
    const myType = worker.assignedResourceType;
    
    // 🔥 Ищем только НЕ ЗАБРОНИРОВАННЫЕ токены (!t.isClaimed)
    const nearbyToken = groundTokens.find(t => 
      t.type === myType && 
      !t.isClaimed && 
      Math.hypot(t.x - worker.x, t.y - worker.y) < 200
    );

    if (nearbyToken) {
      // 🔥 МГНОВЕННО БРОНИРУЕМ ТОКЕН! Другие рабочие его теперь игнорируют.
      nearbyToken.isClaimed = true;

      moveUnit(worker, nearbyToken.x, nearbyToken.y, () => {
        if (!gameState.units.includes(worker)) return;
        worker.carrying += nearbyToken.amount;
        if (typeof spawnResourceToken === "function") spawnResourceToken(worker, myType);
        
        const tIdx = gameState.resourceTokens.indexOf(nearbyToken);
        if (tIdx !== -1) gameState.resourceTokens.splice(tIdx, 1);
        
        setTimeout(() => startWorkerCycle(worker, warehouse), 500);
      });
      return;
    }
  }

  // 4. Поиск обычного камня
  const type = worker.assignedResourceType;
  const allResources = gameState.resources.filter(r => r.type === type && !r.depleted);

  if (allResources.length === 0) {
    worker.assignedResourceType = null;
    setTimeout(() => startWorkerCycle(worker, warehouse), 1000);
    return;
  }

  allResources.sort((a, b) => Math.hypot(a.x - worker.x, a.y - worker.y) - Math.hypot(b.x - worker.x, b.y - worker.y));
  const nearestResource = allResources[0];

  if (nearestResource.currentWorkers >= nearestResource.maxWorkers) {
    worker.assignedResource = null;
    setTimeout(() => startWorkerCycle(worker, warehouse), 1000);
    return;
  }

  const rockRadius = typeof nearestResource.getCurrentRadius === "function" ? nearestResource.getCurrentRadius() : 20;
  const stopDistance = rockRadius + 12;
  const dist = Math.hypot(nearestResource.x - worker.x, nearestResource.y - worker.y);

  const attemptMining = () => {
    const currentDist = Math.hypot(worker.x - nearestResource.x, worker.y - nearestResource.y);

    if (currentDist > stopDistance + 30) {
      if (worker.assignedResource && worker.assignedResource.currentWorkers > 0) {
        worker.assignedResource.currentWorkers--;
      }
      worker.assignedResource = null;
      startWorkerCycle(worker, warehouse);
      return;
    }

    setTimeout(() => {
      if (!gameState.units.includes(worker)) return;
      if (nearestResource.amount > 0 && !nearestResource.depleted) {
        nearestResource.amount--;
        worker.carrying = (worker.carrying || 0) + 5;
        if (!worker.carriedResourceToken && typeof spawnResourceToken === "function") {
          spawnResourceToken(worker, type);
        }
        if (typeof spawnSparkEffect === "function") spawnSparkEffect(worker.x, worker.y);
      }
      if (worker.assignedResource && worker.assignedResource.currentWorkers > 0) {
        worker.assignedResource.currentWorkers--;
      }
      worker.assignedResource = null;
      startWorkerCycle(worker, warehouse);
    }, 2000);
  };

  if (dist <= stopDistance + 10) {
    nearestResource.currentWorkers++;
    worker.assignedResource = nearestResource;
    attemptMining();
  } else {
    // 🔥 СВОБОДНАЯ ТОЧКА ПОДХОДА — не влезет в соседний камень
    const approach = findFreeApproachPoint(worker, nearestResource);

    // 🔥 АНТИ-ЗАСТРЕВАНИЕ: запоминаем дистанцию, если не уменьшается 2 сек — сменим камень
    worker._stuckDist = worker._stuckDist || Infinity;
    worker._stuckTimer = worker._stuckTimer || 0;
    if (dist < worker._stuckDist - 15) {
      worker._stuckDist = dist;
      worker._stuckTimer = 0;
    } else {
      worker._stuckTimer += 1; // грубо, по вызовам цикла
    }
    if (worker._stuckTimer > 6) {
      // Застряли между камнями — освобождаем слот и ищем другой камень
      worker._stuckTimer = 0;
      worker._stuckDist = Infinity;
      if (worker.assignedResource && worker.assignedResource.currentWorkers > 0) {
        worker.assignedResource.currentWorkers--;
      }
      worker.assignedResource = null;
      setTimeout(() => startWorkerCycle(worker, warehouse), 1200);
      return;
    }

    nearestResource.currentWorkers++;
    worker.assignedResource = nearestResource;

    moveUnit(worker, approach.x, approach.y, () => {
      if (!gameState.units.includes(worker)) return;
      attemptMining();
    });
  }
}
function performMining(worker, resource, warehouse, type) {
  // Проверяем, жив ли ещё рабочий
  if (!gameState.units.includes(worker)) return;

  setTimeout(() => {
    // Повторная проверка после задержки (вдруг юнит умер или ушёл)
    if (!gameState.units.includes(worker)) return;

    if (resource.amount > 0 && !resource.depleted) {
      resource.amount--;
      worker.carrying = (worker.carrying || 0) + 5;
      
      if (!worker.carriedResourceToken && typeof spawnResourceToken === "function") {
        spawnResourceToken(worker, type);
      }
      
      if (typeof spawnSparkEffect === "function") {
        spawnSparkEffect(worker.x, worker.y); 
      }
    }
    
    // 🔥 БЕЗОПАСНОЕ ОСВОБОЖДЕНИЕ СЛОТА
    if (worker.assignedResource && worker.assignedResource.currentWorkers > 0) {
      worker.assignedResource.currentWorkers--;
    }
    worker.assignedResource = null;
    
    // Запускаем следующий цикл (доставка или новый поиск)
    startWorkerCycle(worker, warehouse);
  }, 2000); // 2 секунды на добычу
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
  if (unit.isRetreating && unit.health >= unit.maxHealth * 0.80) {
    unit.isRetreating = false;
    unit.retreatTarget = null;
    unit.moveTarget = null; // Сбрасываем, чтобы не дергался
    unit.commandQueue = []; // Очищаем очередь, чтобы начать с чистого листа
    
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

  // 🔥 ШАГ 1.4 (КРИТИЧНО): Инициализируем missionLog ВСЕГДА!
  // Если юнит новый (из else), у него еще нет этого объекта.
  if (!unit.missionLog) {
    unit.missionLog = {
      damageTaken: 0,
      damageDealt: 0,
      events: [],
      alive: true,
      startTime: performance.now(),
      targetId: null,
      reachedTarget: false,
      deathPos: null,
      killedBy: null,
      hitByTurret: false
    };
  }

  // 🧹 Единая зачистка + гарантия боевых полей (теперь fxResetTransient увидит объект и корректно его сбросит)
  fxResetTransient(unit);
  fxEnsureCombat(unit);
  
  unit.__inPool = false;
  unit.__removed = false;
  unit.__inGame = false;   // в игру юнита ставит addUnit — это шаг 3
  return unit;
}