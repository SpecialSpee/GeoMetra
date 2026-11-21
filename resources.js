// 🔥 ФИЗИКА КАМНЕЙ-РЕСУРСОВ (Этап 2)
const ROCK_PHYSICS = {
  // Толчок (импульс) — только взрывные снаряды СДВИГАЮТ камень
  IMPULSE_MISSILE:   40,   // ракета штурмовика / турели-2
  IMPULSE_ARTILLERY: 80,   // арта элиты
  IMPULSE_LASER:     15,   // лазер (слабый толчок)

  // Урон камню — ВСЕ пули СТИРАЮТ камень (как ты и просил!)
  DAMAGE_MISSILE:    30,
  DAMAGE_ARTILLERY:  50,
  DAMAGE_LASER:      20,
  DAMAGE_BULLET:     8,    // 🔥 обычная пуля (файтер/турель) тоже долбит камень

  // Экстренный толчок: если юнит застрял в камне — выталкиваем
  EMERGENCY_PUSH_FORCE:  150,
  EMERGENCY_PUSH_TIME:   1500,  // мс «упирания» перед пиноком
};
// Класс Resource
class Resource {
  constructor(type, x, y, amount, max) {
        //Стабильный seed для отрисовки жил.
    this.seed = Math.floor(Math.random() * 100000);
    this.type = type;
    this.x = x;
    this.y = y;
    this.amount = amount;
    this.max = max;
    this.currentWorkers = 0;
    this.maxWorkers = 10;
    this.depleted = false;
    
    this.sizeCategory = this._determineSize();
    this.baseRadius = this._getBaseRadius();
    this.mass = this._getMass();
    this.friction = 0.98; // 🔥 УВЕЛИЧИЛИ с 0.92 до 0.98 (плавнее скольжение)
    this.vx = 0;
    this.vy = 0;
    this.hp = amount * this._getHpMultiplier();
    this.maxHp = this.hp;
    this.isSleeping = true;
    this.lastHitTime = 0;
    this.crackLevel = 0;
    
    // 🔥 НОВОЕ: Защита от множественных толчков в одном залпе
    this.lastImpulseTime = 0;
    
    if (this.type === "gold") {
      const shape = createGoldShape();
      this.points = shape.points;
      this.rotation = 0;
      this.rotationSpeed = 0.2;
    }
  }
  
  _determineSize() {
    const ratio = this.amount / this.max;
    if (this.max >= 120) return 'large';
    if (this.max >= 70) return 'medium';
    return 'small';
  }
  
  _getBaseRadius() {
    const sizes = { small: 10, medium: 20, large: 30 };
    return sizes[this.sizeCategory] || 30;
  }
  
  _getMass() {
    const masses = { small: 10, medium: 50, large: 100 };
    return masses[this.sizeCategory] || 50;
  }
  
  _getHpMultiplier() {
    const multipliers = { gold: 10, silicon: 8, plasma: 6 };
    return multipliers[this.type] || 8;
  }
  
  getCurrentRadius() {
    const hpRatio = this.hp / this.maxHp;
    return this.baseRadius * Math.sqrt(hpRatio);
  }
  
  isActive() {
    return !this.isSleeping || Math.abs(this.vx) > 0.1 || Math.abs(this.vy) > 0.1;
  }
  
  trySleep() {
    if (Math.abs(this.vx) < 0.1 && Math.abs(this.vy) < 0.1) {
      this.vx = 0;
      this.vy = 0;
      this.isSleeping = true;
    }
  }
  
  // 🔥 ИСПРАВЛЕННЫЙ МЕТОД: Учитываем время между толчками
  applyImpulse(angle, force) {
    const now = performance.now();
    // Если толчок произошёл менее 200мс назад, игнорируем (защита от залпа)
    if (now - this.lastImpulseTime < 200) return;
    
    this.vx += Math.cos(angle) * (force / this.mass);
    this.vy += Math.sin(angle) * (force / this.mass);
    this.isSleeping = false;
    this.lastImpulseTime = now;
  }
  
  takeDamage(damage) {
    this.hp -= damage;
    this.lastHitTime = performance.now();
    
    // 🔥 ПЕРЕСЧЁТ МАССЫ ОТ ТЕКУЩЕГО РАЗМЕРА
    const hpRatio = this.hp / this.maxHp;
    const currentRadius = this.baseRadius * Math.sqrt(Math.max(0.01, hpRatio));
    const baseMass = this._getMass(); // 10, 50 или 100
    this.mass = baseMass * Math.pow(currentRadius / this.baseRadius, 2);
    
    // 🔥 ИСПРАВЛЕНИЕ: УБРАЛИ случайный толчок! 
    // Теперь камень двигается ТОЛЬКО через applyImpulse, который честно делит силу на массу.
    this.isSleeping = false;
    
    // Плавное нарастание трещин
    if (hpRatio < 0.2) this.crackTarget = 3;
    else if (hpRatio < 0.5) this.crackTarget = 2;
    else if (hpRatio < 0.8) this.crackTarget = 1;
    else this.crackTarget = 0;
    
    if (this.hp <= 0) {
      this.hp = 0;
      return true;
    }
    return false;
  }
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
function updateResources(deltaTime) {
  gameState.resources.forEach(resource => {
    if (resource.type === "gold" && resource.rotationSpeed) resource.rotation += resource.rotationSpeed * deltaTime;
    if (resource.amount <= 0) resource.depleted = true;
    
    // 🔥 Плавное нарастание трещин (интерполяция к целевому уровню)
    if (resource.crackTarget !== undefined && resource.crackLevel !== resource.crackTarget) {
      const diff = resource.crackTarget - resource.crackLevel;
      resource.crackLevel += diff * 0.05; // плавный переход за ~0.5 сек
      if (Math.abs(diff) < 0.01) resource.crackLevel = resource.crackTarget;
    }
  });
  cleanupResources();
}
function updateResourceTokens(deltaTime) {
  if (!gameState.resourceTokens) return;

  for (let i = gameState.resourceTokens.length - 1; i >= 0; i--) {
    const token = gameState.resourceTokens[i];

    if (token.isGround) {
      token.x += token.vx * deltaTime;
      token.y += token.vy * deltaTime;
      
      // 🔥 0.98 = плавная длинная инерция, разлёт виден 2-3 секунды
      token.vx *= 0.98;
      token.vy *= 0.98;
      
      if (Math.abs(token.vx) < 0.3 && Math.abs(token.vy) < 0.3) {
        token.vx = 0;
        token.vy = 0;
      }
    }

    token.life -= deltaTime;
    if (token.life <= 0) {
      gameState.resourceTokens.splice(i, 1);
    }
  }
}
// 🪨 ФИЗИКА РЕСУРСОВ (только для активных камней!)
function updateResourcePhysics(deltaTime) {
  const activeResources = gameState.resources.filter(r => r.isActive());
  
  if (activeResources.length === 0) return;
  
  activeResources.forEach(resource => {
    // 🔥 ПЛАВНОЕ ОБНОВЛЕНИЕ ПОЗИЦИИ (не телепорт!)
    resource.x += resource.vx * deltaTime * 60; // Умножаем на 60 для нормализации скорости
    resource.y += resource.vy * deltaTime * 60;
    
    // 🔥 ПЛАВНОЕ ЗАМЕДЛЕНИЕ (инерция)
    resource.vx *= resource.friction;
    resource.vy *= resource.friction;
    
    // Граничные проверки
    const radius = resource.getCurrentRadius();
    if (resource.x < radius) { 
      resource.x = radius; 
      resource.vx *= -0.3; // 🔥 УМЕНЬШИЛИ отскок с -0.5 до -0.3
    }
    if (resource.x > worldWidth - radius) { 
      resource.x = worldWidth - radius; 
      resource.vx *= -0.3;
    }
    if (resource.y < radius) { 
      resource.y = radius; 
      resource.vy *= -0.3;
    }
    if (resource.y > worldHeight - radius) { 
      resource.y = worldHeight - radius; 
      resource.vy *= -0.3;
    }
    
    resource.trySleep();
    
    if (resource.hp <= 0) {
      destroyResource(resource);
    }
  });
  
  if (activeResources.length > 1) {
    resolveRockCollisions(activeResources);
  }
}
function updateWorkerResourceToken(worker) {
  if (worker.carriedResourceToken) {
    const token = worker.carriedResourceToken;
    token.x = worker.x + token.offsetX;
    token.y = worker.y + token.offsetY;
  }
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
// 💥 КОЛЛИЗИИ КАМЕНЬ-КАМЕНЬ
function resolveRockCollisions(activeResources) {
  if (!quadtree || activeResources.length < 2) return;
  
  for (let i = 0; i < activeResources.length; i++) {
    const rockA = activeResources[i];
    const radiusA = rockA.getCurrentRadius();
    
    // Ищем соседей через Quadtree вместо полного перебора!
    const queryRect = { 
      x: rockA.x - radiusA * 2, 
      y: rockA.y - radiusA * 2, 
      width: radiusA * 4, 
      height: radiusA * 4 
    };
    const neighbors = quadtree.query(queryRect);
    
    for (let j = 0; j < neighbors.length; j++) {
      const rockB = neighbors[j];
      if (rockA === rockB || rockB.amount === undefined) continue; // Пропускаем себя и не-камни
      
      const radiusB = rockB.getCurrentRadius();
      const dx = rockB.x - rockA.x;
      const dy = rockB.y - rockA.y;
      const dist = Math.hypot(dx, dy);
      const minDist = radiusA + radiusB;
      
      if (dist < minDist && dist > 0) {
        const nx = dx / dist;
        const ny = dy / dist;
        
        // Разделение
        const overlap = (minDist - dist) / 2;
        rockA.x -= nx * overlap;
        rockA.y -= ny * overlap;
        rockB.x += nx * overlap;
        rockB.y += ny * overlap;
        
        // Импульс
        const dvx = rockA.vx - rockB.vx;
        const dvy = rockA.vy - rockB.vy;
        const dvDotN = dvx * nx + dvy * ny;
        
        if (dvDotN > 0) {
          const massSum = rockA.mass + rockB.mass;
          const impulseA = (2 * rockB.mass * dvDotN) / massSum;
          const impulseB = (2 * rockA.mass * dvDotN) / massSum;
          
          rockA.vx -= impulseA * nx;
          rockA.vy -= impulseA * ny;
          rockB.vx += impulseB * nx;
          rockB.vy += impulseB * ny;
          
          rockA.isSleeping = false;
          rockB.isSleeping = false;
        }
      }
    }
  }
}
// 🗺️ ПРОВЕРКА: БЛОКИРУЕТ ЛИ КАМЕНЬ ПРЯМОЙ ПУТЬ?
function isPathBlockedByRock(fromX, fromY, toX, toY, excludeRadius = 0) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return null;
    
    const nx = dx / dist;
    const ny = dy / dist;
    
    // Проверяем камни в радиусе 200px от линии пути
    const checkRadius = 200;
    const nearbyRocks = gameState.resources.filter(r => 
        r.hp > 0 && 
        r.getCurrentRadius() > 15 &&  // Только крупные камни блокируют
        Math.abs((r.x - fromX) * ny - (r.y - fromY) * nx) < checkRadius
    );
    
    for (const rock of nearbyRocks) {
        const rockRadius = rock.getCurrentRadius();
        // Расстояние от центра камня до линии пути
        const distToLine = Math.abs((rock.x - fromX) * ny - (rock.y - fromY) * nx);
        
        // Проверяем, что камень между началом и концом пути
        const proj = (rock.x - fromX) * nx + (rock.y - fromY) * ny;
        if (proj < 0 || proj > dist) continue;
        
        if (distToLine < rockRadius + excludeRadius) {
            return rock;  // Путь заблокирован этим камнем
        }
    }
    
    return null;  // Путь свободен
}
// 🗺️ ПОИСК ОБХОДНОГО ПУТИ ВОКРУГ КАМНЯ
function findDetourAroundRock(unit, targetX, targetY, blockingRock) {
    const rockRadius = blockingRock.getCurrentRadius();
    const buffer = 20;  // Безопасный отступ
    
    // Вычисляем две точки обхода: слева и справа от камня
    const dx = targetX - unit.x;
    const dy = targetY - unit.y;
    const dist = Math.hypot(dx, dy);
    const nx = dx / dist;
    const ny = dy / dist;
    
    // Перпендикулярный вектор
    const px = -ny;
    const py = nx;
    
    // Точка обхода слева
    const detourLeftX = blockingRock.x + px * (rockRadius + buffer);
    const detourLeftY = blockingRock.y + py * (rockRadius + buffer);
    
    // Точка обхода справа
    const detourRightX = blockingRock.x - px * (rockRadius + buffer);
    const detourRightY = blockingRock.y - py * (rockRadius + buffer);
    
    // Выбираем ближайшую точку обхода
    const distLeft = Math.hypot(detourLeftX - unit.x, detourLeftY - unit.y);
    const distRight = Math.hypot(detourRightX - unit.x, detourRightY - unit.y);
    
    if (distLeft < distRight) {
        return { x: detourLeftX, y: detourLeftY };
    } else {
        return { x: detourRightX, y: detourRightY };
    }
}
// 🔥 Выталкивает камень из ВСЕХ зданий итеративно (до 8 проходов)
function pushRockOutOfAllBuildings(rock, buffer = 25) {
  if (!rock || rock.hp <= 0 || rock.destroyed) return;

  const rockRadius = typeof rock.getCurrentRadius === "function"
    ? rock.getCurrentRadius()
    : (rock.baseRadius || 20);

  let iterations = 0;

  while (iterations < 8) {
    let moved = false;

    for (const b of gameState.buildings) {
      const bx1 = b.x - b.width / 2 - buffer;
      const bx2 = b.x + b.width / 2 + buffer;
      const by1 = b.y - b.height / 2 - buffer;
      const by2 = b.y + b.height / 2 + buffer;

      const closestX = Math.max(bx1, Math.min(rock.x, bx2));
      const closestY = Math.max(by1, Math.min(rock.y, by2));
      const dx = rock.x - closestX;
      const dy = rock.y - closestY;
      const distSq = dx * dx + dy * dy;

      if (distSq < rockRadius * rockRadius) {
        const dist = Math.sqrt(distSq);

        // 🔥 КЛЮЧЕВОЕ: нормализованный вектор через УГОЛ, а не через сырые компоненты
        const angle = (dist < 0.5) ? Math.random() * Math.PI * 2 : Math.atan2(dy, dx);
        const pushNx = Math.cos(angle);
        const pushNy = Math.sin(angle);

        const pushDist = rockRadius + buffer + Math.max(b.width, b.height) / 2 + 12;

        rock.x = b.x + pushNx * pushDist;
        rock.y = b.y + pushNy * pushDist;

        // Границы мира
        rock.x = Math.max(rockRadius, Math.min(worldWidth - rockRadius, rock.x));
        rock.y = Math.max(rockRadius, Math.min(worldHeight - rockRadius, rock.y));

        // 🔥 Крошечный импульс для визуала (трение 0.98 погасит его за ~0.5 сек, бильярда не будет)
        rock.vx = pushNx * 0.3;
        rock.vy = pushNy * 0.3;

        moved = true;
        break; // Пересчитываем пересечения для НОВОЙ позиции камня
      }
    }

    if (!moved) return; // Камень чист — выходим
    iterations++;
  }

  // 🔥 Экстренный случай: камень зажат между зданиями — выносим далеко
  const farAngle = Math.random() * Math.PI * 2;
  rock.x = Math.max(rockRadius, Math.min(worldWidth - rockRadius, rock.x + Math.cos(farAngle) * 220));
  rock.y = Math.max(rockRadius, Math.min(worldHeight - rockRadius, rock.y + Math.sin(farAngle) * 220));

  // Финальная проверка после экстренного выноса
  for (let i = 0; i < 3; i++) {
    let stillStuck = false;
    for (const b of gameState.buildings) {
      const dx = rock.x - b.x, dy = rock.y - b.y;
      const r = rockRadius + Math.max(b.width, b.height) / 2 + buffer;
      if (dx * dx + dy * dy < r * r) { stillStuck = true; break; }
    }
    if (!stillStuck) break;
    const a2 = Math.random() * Math.PI * 2;
    rock.x = Math.max(rockRadius, Math.min(worldWidth - rockRadius, rock.x + Math.cos(a2) * 150));
    rock.y = Math.max(rockRadius, Math.min(worldHeight - rockRadius, rock.y + Math.sin(a2) * 150));
  }
}
// 🔥 Точка входа: вызывается при постройке здания
function pushRocksOutOfBuilding(building, buffer = 25) {
  if (!building || !gameState.resources) return;
  gameState.resources.forEach(rock => pushRockOutOfAllBuildings(rock, buffer));
  if (typeof quadtree !== 'undefined' && quadtree) quadtree.clear();
}
// 🗺️ ПОИСК НЕСКОЛЬКИХ ПУТЕЙ (для сложных лабиринтов)
function findMultiplePaths(unit, targetX, targetY, maxPaths = 3) {
    const paths = [];
    
    // Путь 1: Прямой (если свободен)
    const directBlocked = isPathBlockedByRock(unit.x, unit.y, targetX, targetY, 10);
    if (!directBlocked) {
        paths.push({ x: targetX, y: targetY, priority: 1 });
    }
    
    // Путь 2 и 3: Обход слева и справа от ближайшего камня
    if (directBlocked) {
        const detour = findDetourAroundRock(unit, targetX, targetY, directBlocked);
        paths.push({ x: detour.x, y: detour.y, priority: 2 });
        
        // Альтернативный обход (противоположная сторона)
        const rockRadius = directBlocked.getCurrentRadius();
        const buffer = 20;
        const dx = targetX - unit.x;
        const dy = targetY - unit.y;
        const dist = Math.hypot(dx, dy);
        const nx = dx / dist;
        const ny = dy / dist;
        const px = -ny;
        const py = nx;
        
        const altX = directBlocked.x - px * (rockRadius + buffer);
        const altY = directBlocked.y - py * (rockRadius + buffer);
        paths.push({ x: altX, y: altY, priority: 3 });
    }
    
    return paths.slice(0, maxPaths);
}
function findNearestDeliveryBuilding(x, y, owner) {
  const queryRadius = 500;
  const candidates = getObjectsInRange({ x: x, y: y }, queryRadius).filter(b => b.owner === owner && b.type === "warehouse" && (b.currentDeliveryWorkers || 0) < b.maxDeliveryWorkers);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
  return candidates[0];
}
function findNearestResource(x, y, preferredType) {
  const pos = { x, y };
  let candidates = getObjectsInRange(pos, 1000).filter(r => r.amount > 0 && r.type === preferredType && r.currentWorkers < r.maxWorkers);
  if (candidates.length === 0) candidates = getObjectsInRange(pos, 1000).filter(r => r.amount > 0 && r.currentWorkers < r.maxWorkers);
  let nearest = null, minDist = Infinity;
  candidates.forEach(r => { const d = Math.hypot(r.x - x, r.y - y); if (d < minDist) { minDist = d; nearest = r; } });
  return nearest;
}
// 🔥 УЛУЧШЕННАЯ ПРОВЕРКА КОЛЛИЗИЙ: эффект "скольжения" вместо вибрации
function checkRockCollision(unit) {
  for (const rock of gameState.resources) {
    if (rock.hp <= 0) continue;
    
    const rockRadius = rock.getCurrentRadius();
    const dist = Math.hypot(unit.x - rock.x, unit.y - rock.y);
    const minDist = 10 + rockRadius; // 🔥 Чуть увеличили минимальную дистанцию (было 8)
    
    if (dist < minDist && dist > 0) {
      // Нормаль от центра камня к юниту
      const nx = (unit.x - rock.x) / dist;
      const ny = (unit.y - rock.y) / dist;
      
      // 🔥 1. МЯГКОЕ ВЫТАЛКИВАНИЕ: сдвигаем ровно на величину перекрытия (не телепорт!)
      const overlap = minDist - dist;
      unit.x += nx * overlap;
      unit.y += ny * overlap;
      
      // 🔥 2. ЭФФЕКТ СКОЛЬЖЕНИЯ: гасим только ту часть скорости, которая направлена В камень
      const dotProduct = (unit.vx || 0) * nx + (unit.vy || 0) * ny;
      
      if (dotProduct < 0) { 
        // Юнит летит В камень. Гасим встречную скорость и добавляем микроскопический отскок
        unit.vx -= dotProduct * nx * 1.2; 
        unit.vy -= dotProduct * ny * 1.2;
      }
    }
  }
}
// 💀 РАЗРУШЕНИЕ КАМНЯ
function destroyResource(resource) {
  if (!resource || resource.destroyed) return;
  resource.destroyed = true;
  
  if (typeof spawnDestructionFragments === "function") {
    spawnDestructionFragments(resource.x, resource.y, resource.getCurrentRadius() * 2, resource.getCurrentRadius() * 2, resource.type);
  }
  
  if (!gameState.resourceTokens) gameState.resourceTokens = [];
  
  const rockRadius = resource.getCurrentRadius();
  const totalDrop = Math.floor(resource.amount * (0.20 + Math.random() * 0.10));
  const tokenCount = 3 + Math.floor(Math.random() * 3);
  const amountPerToken = Math.max(1, Math.floor(totalDrop / tokenCount));
  
  for (let i = 0; i < tokenCount; i++) {
    const angle = (i / tokenCount) * Math.PI * 2 + Math.random() * 0.5;
    const speed = 40 + Math.random() * 40; // 🔥 быстрее
    
    // 🔥 СПАВН ЗА ГРАНИЦЕЙ КАМНЯ — чтобы не перекрывался и рабочий мог дойти!
    const spawnDist = rockRadius + 8;
    
    gameState.resourceTokens.push({
      x: resource.x + Math.cos(angle) * spawnDist,
      y: resource.y + Math.sin(angle) * spawnDist,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      type: resource.type,
      amount: amountPerToken,
      life: 20.0,
      maxLife: 20.0,
      isGround: true
    });
  }
  
  const idx = gameState.resources.indexOf(resource);
  if (idx !== -1) gameState.resources.splice(idx, 1);
  if (typeof quadtree !== 'undefined' && quadtree) quadtree.clear();
}
function cleanupResources() {
  gameState.resources = gameState.resources.filter(resource => resource.amount > 0);
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
// 🔥 Проверка: точка не внутри какого-либо камня (кроме целевого)?
function isPointFreeOfRocks(x, y, excludeRock) {
  for (const r of gameState.resources) {
    if (r === excludeRock || r.hp <= 0) continue;
    const rr = typeof r.getCurrentRadius === "function" ? r.getCurrentRadius() : 20;
    if (Math.hypot(r.x - x, r.y - y) < rr + 14) return false;
  }
  return true;
}
// 🔥 Ищем свободную точку подхода к камню: 8 направлений, первое чистое
function findFreeApproachPoint(worker, rock) {
  const rr = typeof rock.getCurrentRadius === "function" ? rock.getCurrentRadius() : 20;
  const dist = rr + 12; // stopDistance
  // Начинаем со стороны рабочего, потом крутимся по кругу
  const startAngle = Math.atan2(worker.y - rock.y, worker.x - rock.x);
  for (let i = 0; i < 8; i++) {
    const a = startAngle + (i * Math.PI / 4);
    const px = rock.x + Math.cos(a) * dist;
    const py = rock.y + Math.sin(a) * dist;
    if (isPointFreeOfRocks(px, py, rock)) {
      return { x: px, y: py };
    }
  }
  // Все 8 заняты — идём дальше от камня (через соседний зазор)
  const px = rock.x + Math.cos(startAngle) * (dist + 40);
  const py = rock.y + Math.sin(startAngle) * (dist + 40);
  return { x: px, y: py };
}