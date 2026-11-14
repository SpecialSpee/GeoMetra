// ============================================================
// inputs.js — Обработка ввода, клики и меню строительства
// ============================================================

// Глобальные переменные для отслеживания состояний
let isDragging = false;
let dragStart = { x: 0, y: 0 };
let cameraStart = { offsetX: 0, offsetY: 0 };
let hasDragged = false; // <-- НОВОЕ: флаг, чтобы отличать клик от перетаскивания

let longTapTimeout = null;
let longTapFired = false;
const longTapDelay = 600;

let isSelecting = false;
let selectionStart = null;
let selectionBox = null;

let suppressMouseClick = false;
let suppressTouchClick = false;
let lastTouchDistance = null;

let currentBuildingForMenu = null;
let buildingMenuOpened = false;

// ============================================================
// ОСНОВНАЯ ЛОГИКА КЛИКА (ОРИГИНАЛЬНАЯ, ВОССТАНОВЛЕННАЯ)
// ============================================================

function processCanvasClick(pos) {
  clearBuildZones();

  const clickedResource = getObjectsInRange(pos, 10)
    .find(r => (r.type === "gold" || r.type === "silicon" || r.type === "plasma"));

  const clickedBuilding = gameState.buildings.find(b =>
    pos.x >= b.x - b.width / 2 &&
    pos.x <= b.x + b.width / 2 &&
    pos.y >= b.y - b.height / 2 &&
    pos.y <= b.y + b.height / 2
  );

  if (clickedBuilding) {
    if (clickedBuilding.owner !== playerId) {
      if (typeof showWarning === "function") showWarning("Это чужое здание!");
      return;
    }

    if (!clickedBuilding.active) {
      if (typeof showWarning === "function") showWarning("Здание ещё не активно!");
      return;
    }

    switch (clickedBuilding.type) {
      case "warehouse":
        if (typeof hireWorkerForPlayer === "function") hireWorkerForPlayer(clickedBuilding);
        return;
      case "barracks":
        if (typeof hireFighterForPlayer === "function") hireFighterForPlayer(clickedBuilding);
        return;
      case "barracks2":
        if (typeof hireAssaultForPlayer === "function") hireAssaultForPlayer(clickedBuilding);
        return;
      case "barracks3":
        if (typeof hireEliteForPlayer === "function") hireEliteForPlayer(clickedBuilding);
        return;
      case "repairWorkshop":
        if (typeof recallRepairmenFromWorkshop === "function") recallRepairmenFromWorkshop(clickedBuilding);
        return;
      default:
        if (["base", "base2", "base3", "beacon"].includes(clickedBuilding.type)) {
          if (typeof showBuildingMenu === "function") showBuildingMenu(clickedBuilding);
          return;
        }
    }
  }

  // === Если клик по ресурсу и выбран рабочий
  if (clickedResource && selectedUnits.length > 0) {
    selectedUnits.forEach(unit => {
      if (unit.type === "worker") {
        unit.commandQueue = [];
        unit.commandQueue.push({ type: "gather", resource: clickedResource });
      }
    });
    return;
  }

  // === Клик по юниту или на пустое место
  const unitRadius = 5;
  const clickedUnit = getObjectsInRange(pos, unitRadius)
    .find(u => u.owner === playerId && u instanceof Unit && u.type !== "worker" && u.type !== "repairman");

  if (clickedUnit) {
    selectedUnits = [clickedUnit];
  } else if (selectedUnits.length > 0) {
    selectedUnits.forEach(unit => {
      unit.commandQueue = [];
      if (unit.currentMovementAnimation) {
        cancelAnimationFrame(unit.currentMovementAnimation);
        unit.currentMovementAnimation = null;
      }
      const randomTarget = getRandomTargetPoint(pos.x, pos.y, 50);
      unit.commandQueue.push({ type: "move", x: randomTarget.x, y: randomTarget.y });

      if (gameMode === "pvp" && typeof sendPvpAction === "function") {
        sendPvpAction({ type: "move", unitId: unit.id, x: randomTarget.x, y: randomTarget.y });
      }
    });
  }
}

// ============================================================
// ОБРАБОТЧИКИ МЫШИ
// ============================================================

canvas.addEventListener("mousedown", function(e) {
  if (e.button !== 0) return;
  isDragging = true;
  hasDragged = false; // Сбрасываем флаг при новом нажатии
  dragStart = { x: e.clientX, y: e.clientY };
  cameraStart = { offsetX: camera.offsetX, offsetY: camera.offsetY };

  const worldPos = screenToWorld(e.clientX, e.clientY);
  const clickedBuilding = gameState.buildings.find(b =>
    b.owner === playerId &&
    worldPos.x >= b.x - b.width / 2 && worldPos.x <= b.x + b.width / 2 &&
    worldPos.y >= b.y - b.height / 2 && worldPos.y <= b.y + b.height / 2
  );

  if (clickedBuilding) {
    saleBuilding = clickedBuilding;
    saleStartTime = performance.now();
    if (typeof createSaleIndicator === "function") createSaleIndicator();
    saleTimeout = setTimeout(() => {
      if (typeof triggerSale === "function") triggerSale(saleBuilding);
      if (typeof clearSaleIndicator === "function") clearSaleIndicator();
      saleTimeout = null;
      saleBuilding = null;
    }, saleDuration);
  }
}, false);

canvas.addEventListener("mousemove", function(e) {
  if (isDragging) {
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    
    // Если сдвинули больше чем на 3 пикселя, считаем это перетаскиванием
    if (Math.hypot(dx, dy) > 3) {
      hasDragged = true; 
    }

    if (Math.hypot(dx, dy) > saleMoveThreshold && saleTimeout) {
      clearTimeout(saleTimeout);
      saleTimeout = null;
      saleBuilding = null;
      if (typeof clearSaleIndicator === "function") clearSaleIndicator();
    }
    camera.offsetX = cameraStart.offsetX + dx;
    camera.offsetY = cameraStart.offsetY + dy;
  }

  if (isSelecting && selectionBox) {
    const x = Math.min(e.clientX, selectionStart.x);
    const y = Math.min(e.clientY, selectionStart.y);
    const w = Math.abs(e.clientX - selectionStart.x);
    const h = Math.abs(e.clientY - selectionStart.y);
    selectionBox.style.left = x + "px";
    selectionBox.style.top = y + "px";
    selectionBox.style.width = w + "px";
    selectionBox.style.height = h + "px";
  }
}, false);

canvas.addEventListener("mouseup", function(e) {
  if (e.button !== 0) return;
  isDragging = false;
  
  if (saleTimeout) {
    clearTimeout(saleTimeout);
    saleTimeout = null;
    saleBuilding = null;
    if (typeof clearSaleIndicator === "function") clearSaleIndicator();
  }

  if (isSelecting && selectionBox) {
    const rect = selectionBox.getBoundingClientRect();
    selectedUnits = gameState.units.filter(unit => {
      if (unit.owner !== playerId) return false;
      if (unit.type === "worker" || unit.type === "repairman") return false;
      const screenPos = worldToScreen(unit.x, unit.y);
      return screenPos.x >= rect.left && screenPos.x <= rect.right &&
             screenPos.y >= rect.top && screenPos.y <= rect.bottom;
    });
    selectionBox.remove();
    selectionBox = null;
    isSelecting = false;
  }
}, false);

canvas.addEventListener("mouseleave", function() {
  isDragging = false;
});

canvas.addEventListener("click", e => {
  const pos = screenToWorld(e.clientX, e.clientY);

  // 🔥 ДОБАВЬ ЭТУ СТРОКУ ПЕРВОЙ:
  if (typeof handlePerkClick === "function" && handlePerkClick(pos)) {
    e.preventDefault();
    return; // Прерываем выполнение, если перк был активирован
  }
  // ГЛАВНОЕ ИСПРАВЛЕНИЕ: Игнорируем клик, если это было перетаскивание камеры
  if (hasDragged) {
    hasDragged = false;
    return; 
  }

  if (suppressMouseClick) return;

  if (typeof perkAwaitingTarget !== 'undefined' && perkAwaitingTarget && typeof shockActive !== 'undefined' && shockActive) {
    if (gameMode === "pvp" && typeof sendPvpAction === "function") sendPvpAction({ type: "shockPerk", x: pos.x, y: pos.y });
    shockZones.push({ x: pos.x, y: pos.y, start: performance.now(), radius: 0, lightningBolts: [] });
    shockActive = false; perkAwaitingTarget = false;
    document.body.style.cursor = "default";
    e.preventDefault();
    return;
  }

  if (typeof perkAwaitingTarget !== 'undefined' && perkAwaitingTarget && typeof bombActive !== 'undefined' && bombActive) {
    if (gameMode === "pvp" && typeof sendPvpAction === "function") sendPvpAction({ type: "bombPerk", x: pos.x, y: pos.y });
    bombZones.push({ x: pos.x, y: pos.y, start: performance.now(), exploded: false, radius: 0 });
    bombActive = false; perkAwaitingTarget = false;
    document.body.style.cursor = "default";
    e.preventDefault();
    return;
  }

  if (typeof perkAwaitingTarget !== 'undefined' && perkAwaitingTarget && typeof reconConfirmCallback === "function") {
    reconConfirmCallback(pos.x, pos.y);
    e.preventDefault();
    return;
  }

  processCanvasClick(pos);
});

canvas.addEventListener("dblclick", e => {
  if (typeof clearBuildZones === "function") clearBuildZones();
  const pos = screenToWorld(e.clientX, e.clientY);

  const clickedBuilding = gameState.buildings.find(b =>
    pos.x >= b.x - b.width / 2 && pos.x <= b.x + b.width / 2 &&
    pos.y >= b.y - b.height / 2 && pos.y <= b.y + b.height / 2
  );
  if (clickedBuilding) return;

  const unitRadius = 5;
  const clickedUnit = gameState.units.find(u =>
    u.owner === playerId && u.type !== "worker" && u.type !== "repairman" &&
    Math.hypot(u.x - pos.x, u.y - pos.y) < unitRadius
  );

  if (clickedUnit) {
    selectedUnits = gameState.units.filter(u =>
      u.owner === playerId && u.type === clickedUnit.type &&
      u.type !== "worker" && u.type !== "repairman"
    );
  } else {
    // Вызов функции выделения рамкой
    startSelectionFrame(e);
  }
});

// ============================================================
// ФУНКЦИЯ ВЫДЕЛЕНИЯ РАМКОЙ (ОРИГИНАЛЬНАЯ)
// ============================================================

function startSelectionFrame(initialEvent) {
  const startX = initialEvent.clientX, startY = initialEvent.clientY;
  const selectionBox = document.createElement("div");
  selectionBox.style.position = "absolute";
  selectionBox.style.border = "1px dashed #00FF00";
  selectionBox.style.backgroundColor = "rgba(0,255,0,0.2)";
  selectionBox.style.left = startX + "px";
  selectionBox.style.top = startY + "px";
  selectionBox.style.zIndex = "1000";
  document.body.appendChild(selectionBox);
  
  function onMouseMove(e) {
    const currentX = e.clientX, currentY = e.clientY;
    const left = Math.min(startX, currentX), top = Math.min(startY, currentY);
    const width = Math.abs(startX - currentX), height = Math.abs(startY - currentY);
    selectionBox.style.left = left + "px";
    selectionBox.style.top = top + "px";
    selectionBox.style.width = width + "px";
    selectionBox.style.height = height + "px";
  }
  
  function onMouseUp(e) {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    const rect = selectionBox.getBoundingClientRect();
    selectedUnits = gameState.units.filter(u => {
      if (u.owner !== playerId) return false;
      if (u.type === "worker" || u.type === "repairman") return false;
      const screenPos = worldToScreen(u.x, u.y);
      return (screenPos.x >= rect.left && screenPos.x <= rect.right &&
              screenPos.y >= rect.top && screenPos.y <= rect.bottom);
    });
    selectionBox.remove();
  }
  
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

canvas.addEventListener("contextmenu", e => {
  e.preventDefault();
  if (typeof clearBuildZones === "function") clearBuildZones();
  const pos = screenToWorld(e.clientX, e.clientY);
  const unitRadius = 5;

  let enemyTarget = gameState.units.find(u => u.owner !== playerId && Math.hypot(u.x - pos.x, u.y - pos.y) < unitRadius);
  if (!enemyTarget) {
    enemyTarget = gameState.buildings.find(b =>
      b.owner !== playerId && pos.x >= b.x - b.width / 2 && pos.x <= b.x + b.width / 2 &&
      pos.y >= b.y - b.height / 2 && pos.y <= b.y + b.height / 2
    );
  }

  if (enemyTarget && selectedUnits.length > 0) {
    selectedUnits.forEach(unit => {
      unit.commandQueue = [];
      unit.commandQueue.push({ type: "attack", target: enemyTarget });
      if (gameMode === "pvp" && typeof sendPvpAction === "function") {
        sendPvpAction({ type: "attack", unitId: unit.id, targetId: enemyTarget.id });
      }
    });
  } else {
    selectedUnits = [];
  }
});

canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const zoomFactor = 1.05;
  let newScale = camera.scale;
  newScale = e.deltaY < 0 ? newScale * zoomFactor : newScale / zoomFactor;
  newScale = Math.max(0.1, Math.min(2.0, newScale));
  
  const worldPoint = screenToWorld(e.clientX, e.clientY);
  camera.scale = newScale;
  const newScreenPoint = worldToScreen(worldPoint.x, worldPoint.y);
  camera.offsetX += e.clientX - newScreenPoint.x;
  camera.offsetY += e.clientY - newScreenPoint.y;
  
  if (typeof clearBuildZones === "function") clearBuildZones();
}, { passive: false });

// ============================================================
// ФУНКЦИИ МЕНЮ СТРОИТЕЛЬСТВА (ВОССТАНОВЛЕНЫ ИЗ ОРИГИНАЛА)
// ============================================================

function clearBuildZones() {
  document.querySelectorAll(".buildZone").forEach(zone => zone.remove());
  const menu = document.getElementById("buildMenu");
  if (menu) menu.remove();
}

// ============================================================
// ПОЛНАЯ ЛОГИКА СТРОИТЕЛЬСТВА (ЗАМЕНИТЬ ЭТОТ БЛОК ВМЕСТО ЗАГЛУШКИ)
// ============================================================

function rectsOverlap(r1, r2) {
  return !(r1.right <= r2.left || r1.left >= r2.right ||
           r1.bottom <= r2.top || r1.top >= r2.bottom);
}

function canSpendResources(cost, owner) {
  const res = getResourcesByOwner(owner);
  return res.gold >= (cost.gold || 0) &&
         res.silicon >= (cost.silicon || 0) &&
         res.plasma >= (cost.plasma || 0);
}

function placeBuilding(x, y, buildingType, owner) {
  if (owner !== playerId) return; // ❗ Не даём строить чужим

  if (["turret", "turret2", "turret3"].includes(buildingType)) {
    const beacons = gameState.buildings.filter(b => b.owner === playerId && b.type === "beacon").length;
    const turrets = gameState.buildings.filter(b =>
      b.owner === playerId && ["turret", "turret2", "turret3"].includes(b.type)
    ).length;

    if (turrets >= 1 && turrets >= beacons * 3) {
      showWarning("Недостаточно маяков. Максимум 3 турели на каждый маяк.");
      return;
    }
  }

  const building = new Building(buildingType, owner, x, y);
  gameState.recentBuilds = gameState.recentBuilds || [];
  gameState.recentBuilds.push({ 
    time: performance.now(), 
    type: building.type,
    owner: owner  // 🔥 Добавляем владельца
  });
  
  const buildingDimensions = {
    warehouse: { width: 10, height: 10 },
    repairWorkshop: { width: 10, height: 10 },
    barracks: { width: 15, height: 15 },
    barracks2: { width: 15, height: 15 },
    barracks3: { width: 15, height: 15 },
    turret: { width: 12, height: 12 },
    turret2: { width: 15, height: 17 },
    turret3: { width: 14, height: 15 },
    beacon: { width: 7, height: 20 },
    base: { width: 20, height: 20 },
    base2: { width: 25, height: 30 },
    base3: { width: 30, height: 30 }
  };

  const dims = buildingDimensions[buildingType] || { width: 20, height: 20 };
  const newRect = {
    left: x - dims.width / 2,
    top: y - dims.height / 2,
    right: x + dims.width / 2,
    bottom: y + dims.height / 2
  };

  for (let b of gameState.buildings) {
    const bRect = {
      left: b.x - b.width / 2 - 5,
      top: b.y - b.height / 2 - 5,
      right: b.x + b.width / 2 + 5,
      bottom: b.y + b.height / 2 + 5
    };
    if (rectsOverlap(newRect, bRect)) {
      showWarning("Нельзя строить здания, накладывая их друг на друга");
      return;
    }
  }

  // Списание ресурсов
  let cost;
  switch (buildingType) {
    case "warehouse": cost = WAREHOUSE_COST; break;
    case "repairWorkshop": cost = REPAIR_WORKSHOP_COST; break;
    case "barracks": cost = BARRACKS_COST; break;
    case "barracks2": cost = BARRACKS2_COST; break;
    case "barracks3": cost = BARRACKS3_COST; break;
    case "turret": cost = TURRET_COST; break;
    case "turret2": cost = TURRET2_COST; break;
    case "turret3": cost = TURRET3_COST; break;
    case "beacon": cost = BEACON_COST; break;
    case "base": cost = BASE_COST; break;
    case "base2": cost = BASE2_COST; break;
    case "base3": cost = BASE3_COST; break;
    default: cost = { gold: 0, silicon: 0, plasma: 0 };
  }

  if (!canSpendResources(cost, playerId)) {
    const missing = getMissingResources(cost, playerId);
    showWarning(`Не хватает: золото — ${missing.gold}, кремний — ${missing.silicon}, плазма — ${missing.plasma}`);
    return;
  }

  gameState.playerResources.gold -= cost.gold;
  gameState.playerResources.silicon -= cost.silicon;
  gameState.playerResources.plasma -= cost.plasma;
  updateResourceUI();

  gameState.buildings.push(building);

  if (["turret", "turret2", "turret3"].includes(buildingType)) {
    if (typeof startTurretCycle === "function") startTurretCycle(building);
  }

  const menu = document.getElementById("buildMenu");
  if (menu) menu.remove();

  if (gameMode === "pvp" && typeof sendPvpAction === "function") {
    sendPvpAction({
      type: "build",
      buildingType,
      x,
      y,
      owner: playerId,
      id: building.id
    });
  }

  return building;
}
