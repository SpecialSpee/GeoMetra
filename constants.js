let gameStarted = false;
let buildQueue = [];



let shockAvailable = true;
let shockActive = false;
let shockCooldown = 25000; // 60 секунд
let shockRadius = 120;
let activeShockTarget = null;
let shockZones = [];



let bombCooldown = 45000; // 60 секунд
let bombRadius = 100;
let activeBombTarget = null;
let bombZones = [];
let bombMaxDamage = 160;
let bombActive = false;
let bombAvailable = true;
let bombAwaitingTarget = false;

let playerBase = null;
let aiBase = null;



let aiLogicInterval;
window.gameMode = "single"; // или просто: gameMode = "single";






// constants.js (новый блок констант)
const BUILDING_ACTIVATION_DELAYS = {
  base: 5000,            // 5 секунд
  base2: 8000,           // 8 секунд
  base3: 12000,          // 12 секунд
  barracks: 4000,        // 4 секунды
  barracks2: 7000,       // 7 секунд
  barracks3: 10000,      // 10 секунд
  warehouse: 3000,       // 3 секунды
  repairWorkshop: 4000,  // 4 секунды
  turret: 6000,          // 6 секунд
  turret2: 9000,         // 9 секунд
  turret3: 11000,        // 11 секунд
  beacon: 5000           // 5 секунд
};

   // Глобальные флаги состояния интерфейса
   let wasOrientationWarningShownAtStart = false;
   let orientationPauseActive = false;
   let perkAwaitingTarget = false;

const queryCache = new Map();
const CACHE_DURATION = 100; // время кэширования в мс

// Глобальное состояние игры
let gameState = {
  buildings: [],
  units: [],
  resources: [],
  bullets: [],
  particles: [],
  resourceTokens: [],
  fragments: [],              // ← ДОБАВЬ ЭТУ СТРОКУ
  lasers: [],                 // ← И ЭТУ (для turret3)
  capturePoints: [],          // ← И ЭТУ (для точек захвата)
  recentBuilds: [],           // ← И ЭТУ (для ИИ)
  recentLosses: [],           // ← И ЭТУ
  playerResources: { gold: 100, silicon: 100, plasma: 50 },
  aiResources: { gold: 100, silicon: 100, plasma: 50 },
  playerScore: 0,
  attackers: [],
  repairmen: [],
  defenders: []
};



const iconPaths = [
  "src/icons/base.png",
  "src/icons/base2.png",
  "src/icons/base3.png",
  "src/icons/barracks.png",
  "src/icons/barracks2.png",
  "src/icons/barracks3.png",
  "src/icons/warehouse.png",
  "src/icons/repairWorkshop.png",
  "src/icons/turret.png",
  "src/icons/turret2.png",
  "src/icons/turret3.png",
	
	
    "src/models/worker.png",
    "src/models/repairman.png",
	"src/models/fighter.png",
	"src/models/elite.png",
    "src/models/assault.png"

	
];

const preloadedIcons = {};
iconPaths.forEach(path => {
  const img = new Image();
  img.src = path;
  preloadedIcons[path] = img;
});


const bulletPools = {
  regular: [],
  missile: [],
};

const unitPools = {
  worker: [],
  repairman: [],
  fighter: [],
  assault: [],
  elite: []
};

const fragmentPool = [];


const SCORE_VALUES = {
  fighter: 0.01,
  assault: 0.025,
  elite: 0.05,
  worker: 0.005,
  repairman: 0.003,
  warehouse: 0.01,
  repairWorkshop: 0.019,
  barracks: 0.07,
  barracks2: 0.15,
  barracks3: 0.3,
  turret: 0.04,
  turret2: 0.09,
  turret3: 0.14,
  beacon: 0.09,
  base: 0.6,
  base2: 1,
  base3: 1.9

};

const fragmentColors = {
  worker: "#00FF00",      // зелёный для рабочих
  fighter: "#FF0000",     // красный для истребителей
  assault: "#800080",     // фиолетовый для штурмовиков
  repairman: "#0000FF",   // синий для ремонтников
  elite: "#808080",       // серый для элитных
  building: "#FFFF00"     // например, жёлтый для зданий (можно расширить для разных типов зданий)
};

// Пересмотр баланса цен – увеличены затраты для повышения стоимости юнитов и построек
// Базовые постройки и инфраструктура
const BASE_COST = { gold:67, silicon: 73, plasma: 32 };
const WAREHOUSE_COST = { gold: 12, silicon: 5, plasma: 3 };
const WORKER_COST = { gold: 4, silicon: 6, plasma: 3 };
const REPAIR_WORKSHOP_COST = { gold: 15, silicon: 7, plasma: 4 };
const REPAIRMAN_COST = { gold: 5, silicon: 7, plasma: 4 };
// Боевые постройки и юниты первого уровня
const BARRACKS_COST = { gold: 41, silicon: 52, plasma: 15 };
const FIGHTER_COST = { gold: 13, silicon: 15, plasma: 8 };
const ASSAULT_COST = { gold: 23, silicon: 26, plasma: 12 };
const ELITE_COST = { gold: 58, silicon: 73, plasma: 36 };
const TURRET_COST = { gold: 17, silicon: 21, plasma: 7 };
const BEACON_COST = { gold: 27, silicon: 38, plasma: 12 };
// Улучшенные постройки (2 уровень)
const BASE2_COST = { gold: 81, silicon: 92, plasma: 43 };
const BARRACKS2_COST = { gold: 65, silicon: 72, plasma: 19 };
const TURRET2_COST = { gold: 21, silicon: 36, plasma: 14 };
const TURRET3_COST = { gold: 27, silicon: 46, plasma: 19 };
// Поздняя игра (3 уровень)
const BASE3_COST = { gold: 92, silicon: 108, plasma: 52 };
const BARRACKS3_COST = { gold: 73, silicon: 84, plasma: 24 };



// === Константы и глобальные переменные для тумана войны ===
const FOG_CELL_SIZE = 45;   // размер ячейки тумана (в мировых единицах)

const VISION_RADIUS = 250;     // радиус видимости юнита игрока (в мировых единицах)



const WORKER_SPEED = 50;
const FIGHTER_BULLET_CONFIG = { speed: 200, lifetime: 0.8, damage: 10 };
const TURRET_BULLET_CONFIG = { speed: 300, lifetime: 1.3, damage: 29 };
const TURRET_LASER_CONFIG = { lifetime: 0.3, damage: 61 };
const AUTO_COLLECT_ENABLED = true;

const ASSAULT_VISION_RANGE = 310;
const FIGHTER_VISION_RANGE = 210;
const ELITE_VISION_RANGE =  530;

const MISSILE_CONFIG = { 
  speed: 170,          // Скорость полёта ракеты
  lifetime: 3,         // Время жизни (секунд)
  damage: 34,          // Основной урон при попадании
  splashRadius: 30,    // Радиус действия splash-урона
  splashDamage: 7     // Урон по объектам в области
};

const MELEE_BULLET_CONFIG = {
  speed: 270,     // скорость пули (можно настроить)
  lifetime: 0.8,  // время жизни пули (короткое, так как это ближний бой)
  damage: 8       // урон одной пули
};


// Дополнительная константа для артиллерии
const ARTILLERY_BULLET_CONFIG = {
  speed: 120,          // скорость снаряда
  lifetime: 6,       // время жизни (секунд)
  damage: 40,          // базовый урон
  splashRadius: 40,    // радиус splash-урона
  splashDamage: 10     // урон по объектам в области
};

// Дополнительные константы для динамичного поведения fighter
const BASE_SPEED = 60;
const TURN_SPEED = 40;
const WANDER_STRENGTH = 70;
const MIN_TURN_ANGLE = 200 * Math.PI / 180;
const MAX_TURN_ANGLE = 300 * Math.PI / 180;



let selectedUnits = [];



function randomFarPosition(building, minDistance = 200) {
  if (!building || building.x == null || building.y == null) {
    console.warn("[AI] randomFarPosition(): здание не передано или некорректно");
    return { x: 200 + Math.random() * 400, y: 200 + Math.random() * 400 };
  }

  const angle = Math.random() * Math.PI * 3;
  const distance = minDistance + Math.random() * minDistance;
  return { 
    x: building.x + distance * Math.cos(angle), 
    y: building.y + distance * Math.sin(angle) 
  };
}


function countBuildings(buildingType, owner) {
  return gameState.buildings.filter(b => b.owner === owner && b.type === buildingType).length;
}

function canAfford(cost, owner) {
  const res = owner === "ai"
    ? gameState.aiResources
    : gameState.playerResources;

  return res.gold >= (cost.gold || 0) &&
       res.silicon >= (cost.silicon || 0) &&
       res.plasma >= (cost.plasma || 0);
}


// Функция оценки плотности ресурсов в заданной области
function evaluateResourceDensity(x, y, radius) {
  let density = 0;
  const pos = { x, y };
  // Запрос только ресурсов (предполагается, что у ресурсов есть тип gold, silicon или plasma)
  const resources = getObjectsInRange(pos, radius)
    .filter(r => r.type === "gold" || r.type === "silicon" || r.type === "plasma");
  resources.forEach(resource => {
    const d = Math.hypot(resource.x - x, resource.y - y);
    if (d < radius) {
      density += resource.amount;
    }
  });
  return density;
}

function attemptToBuildWarehouse() {
  if (countBuildings("warehouse", "ai") < DESIRED_WAREHOUSE_COUNT) {
    const pos = findOptimalWarehousePosition();
    if (pos && canAfford(WAREHOUSE_COST, "ai")) {
      if (aiPlaceBuilding("warehouse", pos.x, pos.y)) {
        //console.log("AI построил склад в оптимальной позиции", pos);
      }
    }
  }
}

function randomNearbyPosition(building, distance) {
  const angle = Math.random() * Math.PI * 2;
  return { x: building.x + distance * Math.cos(angle), y: building.y + distance * Math.sin(angle) };
}

/**
 * Проверяет, находится ли точка (x, y) в зоне строительства любого здания.
 * Для расчёта зоны используется getBuildZoneRect(building), который берёт
 * buildZoneMultiplier или подставляет 20.
 */
function isPositionInBuildingZone(x, y) {
  for (let b of gameState.buildings) {
    // Если нужно только для игрока, можно раскомментировать:
    // if (b.owner !== "player") continue;

    const rect = getBuildZoneRect(b);
    if (
      x >= rect.left &&
      x <= rect.right &&
      y >= rect.top &&
      y <= rect.bottom
    ) {
      return true;
    }
  }
  return false;
}

function startRepairProcess(repairman, command) {
  const target = command.target;

  if (!target || target.health >= target.maxHealth || target.health <= 0) {
    repairman.busyRepair = false;
    processCommandQueue(repairman);
    return;
  }

  const repairRate = 5;
  const intervalTime = 100;
  const REPAIR_COST = { gold: 0.3, silicon: 0.4, plasma: 0.2 };
  const intervalsPerCycle = 5000 / intervalTime;
  const costGoldPerInterval = REPAIR_COST.gold / intervalsPerCycle;
  const costSiliconPerInterval = REPAIR_COST.silicon / intervalsPerCycle;
  const costPlasmaPerInterval = REPAIR_COST.plasma / intervalsPerCycle;

  repairman.repairIntervalId = setInterval(() => {
    if (target.health >= target.maxHealth || target.health <= 0) {
      clearInterval(repairman.repairIntervalId);
      repairman.repairIntervalId = null;
      repairman.busyRepair = false;

      // Убираем ремонтника из списка цели
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

    // Визуальный эффект от каждого ремонтника
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
// Универсальная функция запроса ремонта
function requestRepair(target, workshop) {
  // Инициализация массива ремонтников, если нет
  if (!target.repairmen) {
    target.repairmen = [];
  }

  // Поиск свободного ремонтника в мастерской
  const repairman = gameState.repairmen.find(r =>
    r.homeWorkshop === workshop && !r.busyRepair && !r.hidden
  );

  if (repairman && !target.repairmen.includes(repairman)) {
    target.repairmen.push(repairman);
    repairman.busyRepair = true;
    repairman.commandQueue = [
      { type: "move", x: target.x, y: target.y },
      { type: "repair", target }
    ];
    processCommandQueue(repairman);
  }
}

// Функция автоматического ремонта повреждённых объектов
function autoRepairDamagedObjects() {
  // Собираем все объекты, у которых здоровье значительно ниже максимального
  const repairables = [].concat(
    gameState.units.filter(u => u.health < u.maxHealth * 0.9),
    gameState.buildings.filter(b => b.health < b.maxHealth * 0.9)
  );
  
  repairables.forEach(target => {
    // Если объект уже ремонтируется или с момента последней попытки прошло меньше 5 секунд – пропускаем
    if (target.isRepairing && target.repairAttemptedAt && performance.now() - target.repairAttemptedAt < 5000) {
      return;
    }
    if (target.isRepairing && performance.now() - target.repairAttemptedAt >= 5000) {
      target.isRepairing = false;
    }
    
    // Находим ближайшую ремонтную мастерскую
    let workshops = gameState.buildings.filter(b => b.owner === target.owner && b.type === "repairWorkshop");
    if (workshops.length === 0) return;
    
    // Сортируем мастерские по расстоянию до объекта
    workshops.sort((a, b) =>
      Math.hypot(target.x - a.x, target.y - a.y) - Math.hypot(target.x - b.x, target.y - b.y)
    );
    const nearestWorkshop = workshops[0];
    
    // Если объект находится в зоне контроля мастерской, инициируем ремонт
    if (Math.hypot(target.x - nearestWorkshop.x, target.y - nearestWorkshop.y) <= nearestWorkshop.controlRadius) {
      requestRepair(target, nearestWorkshop);
    }
  });
}

// Функция, возвращающая прямоугольник зоны строительства для здания
function getBuildZoneRect(building) {
  const zoneMargin = building.buildZoneMultiplier || 20;
  return {
    left:   building.x - building.width  / 2 - zoneMargin,
    top:    building.y - building.height / 2 - zoneMargin,
    right:  building.x + building.width  / 2 + zoneMargin,
    bottom: building.y + building.height / 2 + zoneMargin
  };
}

// Функция проверки, находится ли точка (x, y) в зоне строительства какого-либо здания
function isInAnyBuildZone(x, y) {
  // Ищем объекты в радиусе 100, которые являются Building
  const candidates = getObjectsInRange({ x, y }, 100)
    .filter(b => b instanceof Building);
    
  for (let b of candidates) {
    let left, top, right, bottom;
    if (b.type === "wall") {
      // Фиксированные размеры 10x10 для стен: центрированная зона [x-5, y-5, x+5, y+5]
      left = b.x - 2;
      top = b.y - 2;
      right = b.x + 2;
      bottom = b.y + 2;
    } else {
      // Для остальных зданий: склады – меньший margin, остальные – по buildZoneMultiplier или 20.
      const margin = (b.type === "warehouse") ? 10 : (b.buildZoneMultiplier || 20);
      left = b.x - b.width / 2 - margin;
      top = b.y - b.height / 2 - margin;
      right = b.x + b.width / 2 + margin;
      bottom = b.y + b.height / 2 + margin;
    }
    
    if (x >= left && x <= right && y >= top && y <= bottom) {
      return true;
    }
  }
  return false;
}
// Функция проверки, находится ли точка в пределах зоны союзных построек.
// Здесь в качестве зоны используется радиус от каждой союзной постройки.
function isWithinAlliedZone(x, y) {
  const zoneRadius = 100; // можно настроить радиус зоны
  // Считаем, что база ИИ тоже является союзной постройкой
  if (Math.hypot(x - aiBase.x, y - aiBase.y) <= zoneRadius) {
    return true;
  }
  // Проверяем остальные союзные здания
  for (const building of gameState.buildings.filter(b => b.owner === "ai")) {
    if (Math.hypot(x - building.x, y - building.y) <= zoneRadius) {
      return true;
    }
  }
  return false;
}

function loadGame() {
  try {
    // Загружаем сохранённое состояние игры из localStorage
    const state = localStorage.getItem("savedGameState");
    if (state) {
      let loadedState = JSON.parse(state);
      // Убираем данные тумана, если они есть
      delete loadedState.fogMap;
      delete loadedState.persistentFogMap;
      
      // Восстанавливаем основное состояние игры
      Object.assign(gameState, loadedState);
      
      // Загружаем отдельно сохранённый счёт игрока
      const savedScore = localStorage.getItem("playerScore");
      if (savedScore !== null) {
        gameState.playerScore = parseInt(savedScore, 10);
        updateScoreUI();
      }
      
      // Переинициализируем туман
      fogMap = [];
      persistentFogMap = [];
      initFogOfWar();
      updateFogOfWar();
      
      alert("Игра загружена!");
    } else {
      alert("Нет сохранённых данных!");
    }
  } catch (e) {
    console.error("Ошибка загрузки:", e);
    alert("Ошибка загрузки!");
  }
}

function exitGame() {
  if (confirm("Вы действительно хотите выйти?")) {
    location.reload();
  }
}

function stopAllIntervals() {
  // Получаем ID последнего интервала
  let highestId = setInterval(() => {}, 1000);
  // Останавливаем все интервалы от 0 до highestId
  for (let i = 0; i <= highestId; i++) {
    clearInterval(i);
  }
}

function checkVictoryConditions() {
  if (gameState.gameEnded) return;

  if (gameMode === "single") {
    const playerBuildings = gameState.buildings.filter(b => b.owner === "player");
    const aiBuildings = gameState.buildings.filter(b => b.owner === "ai");

    if (aiBuildings.length === 0) {
      clearInterval(aiLogicInterval);
      cancelAnimationFrame(gameLoopId);
      gameState.gameEnded = true;
      setTimeout(() => {
        showVictoryScreen("Победа! Все здания противника уничтожены.");
      }, 3000);
      return;
    }

    if (playerBuildings.length === 0) {
      clearInterval(aiLogicInterval);
      cancelAnimationFrame(gameLoopId);
      gameState.gameEnded = true;
      setTimeout(() => {
        showVictoryScreen("Поражение! Все ваши здания уничтожены.");
      }, 3000);
      return;
    }
  }

  // === PvP режим ===
  if (gameMode === "pvp" && performance.now() - pvpStartedAt > 3000) {
    const playerBuildings = gameState.buildings.filter(b => b.owner === playerId);
    const enemyBuildings = gameState.buildings.filter(b => b.owner === opponentId);

    if (enemyBuildings.length === 0) {
      cancelAnimationFrame(gameLoopId);
      gameState.gameEnded = true;
      setTimeout(() => {
        showVictoryScreen("🎉 Ты победил! Все здания врага уничтожены.");
      }, 2000);
      return;
    }

    if (playerBuildings.length === 0) {
      cancelAnimationFrame(gameLoopId);
      gameState.gameEnded = true;
      setTimeout(() => {
        showVictoryScreen("💀 Ты проиграл! Все твои здания уничтожены.");
      }, 2000);
      return;
    }
  }
}

function showVictoryScreen(message) {
  let victoryScreen = document.getElementById("victoryScreen");
  if (!victoryScreen) {
    victoryScreen = document.createElement("div");
    victoryScreen.id = "victoryScreen";
    victoryScreen.style.position = "fixed";
    victoryScreen.style.top = "0";
    victoryScreen.style.left = "0";
    victoryScreen.style.width = "100vw";
    victoryScreen.style.height = "100vh";
    victoryScreen.style.zIndex = "10002";
    victoryScreen.style.display = "flex";
    victoryScreen.style.flexDirection = "column";
    victoryScreen.style.justifyContent = "center";
    victoryScreen.style.alignItems = "center";
    victoryScreen.style.backgroundColor = "rgba(0,0,0,0.8)";
    document.body.appendChild(victoryScreen);
  }
  victoryScreen.innerHTML = "";

  // Создаем видеофон, аналогичный загрузочному экрану
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.style.position = "absolute";
  video.style.top = "50%";
  video.style.left = "50%";
  video.style.transform = "translate(-50%, -55%) scale(1.1)";
  video.style.minWidth = "100%";
  video.style.minHeight = "100%";
  video.style.objectFit = "cover";
  video.style.zIndex = "-1";
  const source = document.createElement("source");
  source.src = "src/video/background2.mp4"; // путь к видеофайлу
  source.type = "video/mp4";
  video.appendChild(source);
  victoryScreen.appendChild(video);

  // Контейнер для сообщения и кнопок
  const container = document.createElement("div");
  container.style.position = "relative";
  container.style.zIndex = "10";
  container.style.textAlign = "center";
  container.style.color = "#fff";
  container.style.padding = "20px";
  container.style.backgroundColor = "rgba(0,0,0,0.5)";
  container.style.borderRadius = "10px";

  // Сообщение о завершении игры
  const messageElement = document.createElement("h1");
  messageElement.innerText = message;
  messageElement.style.marginBottom = "20px";
  container.appendChild(messageElement);

  // Кнопка "Выйти"
  const exitButton = document.createElement("button");
  exitButton.innerText = "Выйти";
  exitButton.onclick = exitGame;
  container.appendChild(exitButton);

  // Оформляем кнопки
  const buttons = container.getElementsByTagName("button");
  for (let btn of buttons) {
    btn.style.margin = "0 10px";
    btn.style.padding = "10px 20px";
    btn.style.fontSize = "16px";
  }

  victoryScreen.appendChild(container);
	stopAllIntervals();
}

function rectsOverlap(r1, r2) {
  return !(r1.right <= r2.left || r1.left >= r2.right ||
           r1.bottom <= r2.top || r1.top >= r2.bottom);
}

const buildingCosts = {
  base: BASE_COST,
  base2: BASE2_COST,
  base3: BASE3_COST,
  warehouse: WAREHOUSE_COST,
  repairWorkshop: REPAIR_WORKSHOP_COST,
  barracks: BARRACKS_COST,
  barracks2: BARRACKS2_COST,
  barracks3: BARRACKS3_COST,
  turret: TURRET_COST,
  turret2: TURRET2_COST,
  turret3: TURRET3_COST,
  beacon: BEACON_COST
};

const unitCosts = {
  worker: WORKER_COST,
  repairman: REPAIRMAN_COST,
  fighter: FIGHTER_COST,
  assault: ASSAULT_COST,
  elite: ELITE_COST
};



