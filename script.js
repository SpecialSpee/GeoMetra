// ============================================================
// script.js — Инициализация, глобальное состояние и поток
// ============================================================

if (typeof unitPools !== "object") {
  window.unitPools = { worker: [], repairman: [], fighter: [], assault: [], elite: [] };
}

let reconActive = false, reconCooldown = 20000, reconZones = [];
const scoreCounterEl = document.getElementById("scoreCounter");

function loadPlayerScore() {
  const savedScore = localStorage.getItem("playerScore");
  gameState.playerScore = savedScore !== null ? parseFloat(savedScore, 10) : 0;
  updateScoreUI();
}

function updateScoreUI() {
  if (scoreCounterEl) {
    scoreCounterEl.innerHTML = "GEO: " + gameState.playerScore.toLocaleString('ru-RU', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  }
}

function savePlayerScore() {
  localStorage.setItem("playerScore", gameState.playerScore);
}

window.addEventListener("beforeunload", () => { savePlayerScore(); });



let fogMap = [], persistentFogMap = [];
const margin = 200, minBaseDistancePercent = 60;

// ============================================================
// ОРИГИНАЛЬНЫЕ ФУНКЦИИ МЕНЮ СТРОИТЕЛЬСТВА (С КАРТИНКАМИ)
// ============================================================

function hasBuilding(type, owner) {
  return gameState.buildings.some(b => b.owner === owner && b.type === type && b.active);
}

function canAfford(cost, owner) {
  const res = owner === "ai" ? gameState.aiResources : gameState.playerResources;
  return res.gold >= (cost.gold || 0) &&
         res.silicon >= (cost.silicon || 0) &&
         res.plasma >= (cost.plasma || 0);
}

// ============================================================
// ПРОВЕРКИ ДОСТУПНОСТИ СТРОИТЕЛЬСТВА
// ============================================================

const playerBuildingPrerequisites = {
  "barracks": ["warehouse", "repairWorkshop"],
  "turret": ["warehouse", "repairWorkshop"],
  "beacon": ["barracks", "turret", "repairWorkshop"],
  "base2": ["barracks"],
  "barracks2": ["base2"],
  "turret2": ["base2"],
  "base3": ["barracks2"],
  "barracks3": ["base3"],
  "turret3": ["base3"]
};

function canPlayerBuild(buildingType) {
  if (gameMode === "tutorial") {
    // Разрешаем только эти здания в туториале
    const allowedInTutorial = ["warehouse", "repairWorkshop", "barracks", "turret", "beacon"];
    if (!allowedInTutorial.includes(buildingType)) return false;

    // После постройки маяка — блокируем всё строительство
    const beaconBuilt = gameState.buildings.some(b => b.owner === playerId && b.type === "beacon");
    if (beaconBuilt) return false;
  }

  const prereqs = playerBuildingPrerequisites[buildingType];
  if (!prereqs) return true;

  for (const prereq of prereqs) {
    if (!gameState.buildings.some(b => b.owner === playerId && b.type === prereq && b.active)) {
      return false;
    }
  }

  // Ограничение на уникальные здания
  if (["barracks", "barracks2", "barracks3", "base", "base2", "base3"].includes(buildingType)) {
    if (gameState.buildings.some(b => b.owner === playerId && b.type === buildingType)) {
      return false;
    }
  }

  return true;
}

function getMenuItem(buildingType, label) {
  const div = document.createElement("div");
  let available = false;

  // === Проверки доступности
  if (buildingType === "warehouse") {
    available = canAfford(WAREHOUSE_COST, playerId);
  } else if (buildingType === "repairWorkshop") {
    available = canAfford(REPAIR_WORKSHOP_COST, playerId);
  } else if (buildingType === "barracks") {
    available = hasBuilding("warehouse", playerId) &&
                hasBuilding("repairWorkshop", playerId) &&
                !hasBuilding("barracks", playerId) &&
                canAfford(BARRACKS_COST, playerId);
  } else if (buildingType === "turret") {
    available = hasBuilding("warehouse", playerId) &&
                hasBuilding("barracks", playerId) &&
                hasBuilding("repairWorkshop", playerId) &&
                canAfford(TURRET_COST, playerId);
  } else if (buildingType === "beacon") {
    available = hasBuilding("warehouse", playerId) &&
                hasBuilding("barracks", playerId) &&
                hasBuilding("turret", playerId) &&
                hasBuilding("repairWorkshop", playerId) &&
                canAfford(BEACON_COST, playerId);
  } else if (buildingType === "base2") {
    available = !hasBuilding("base2", playerId) &&
                hasBuilding("warehouse", playerId) &&
                hasBuilding("barracks", playerId) &&
                hasBuilding("turret", playerId) &&
                hasBuilding("repairWorkshop", playerId) &&
                hasBuilding("beacon", playerId) &&
                canAfford(BASE2_COST, playerId);
  } else if (buildingType === "barracks2") {
    available = hasBuilding("base2", playerId) &&
                !hasBuilding("barracks2", playerId) &&
                canAfford(BARRACKS2_COST, playerId);
  } else if (buildingType === "turret2") {
    available = hasBuilding("barracks2", playerId) &&
                canAfford(TURRET2_COST, playerId);
  } else if (buildingType === "base3") {
    available = hasBuilding("base2", playerId) &&
                hasBuilding("barracks2", playerId) &&
                hasBuilding("turret2", playerId) &&
                !hasBuilding("base3", playerId) &&
                canAfford(BASE3_COST, playerId);
  } else if (buildingType === "barracks3") {
    available = hasBuilding("base3", playerId) &&
                !hasBuilding("barracks3", playerId) &&
                canAfford(BARRACKS3_COST, playerId);
  } else if (buildingType === "turret3") {
    available = hasBuilding("base3", playerId) &&
                hasBuilding("barracks3", playerId) &&
                canAfford(TURRET3_COST, playerId);
  }

  // === DOM-структура
  div.setAttribute("data-type", buildingType);
  div.style.color = available ? "white" : "grey";
  div.style.cursor = available ? "pointer" : "not-allowed";
  div.style.margin = "4px";
  div.style.textAlign = "center";

  const icon = document.createElement("img");
  icon.src = iconMap[buildingType] || `src/models/${buildingType}.png`;
  icon.alt = label;
  icon.style.width = "60px";
  icon.style.height = "60px";
  // Добавим стиль для плавной загрузки картинки
  icon.style.objectFit = "contain";

  const text = document.createElement("div");
  text.innerText = label;
  text.style.marginTop = "4px";
  text.style.fontSize = "12px";

  div.appendChild(icon);
  div.appendChild(text);

  // === Обработчик клика
  div.addEventListener("click", () => {
    if (available) {
      if (document.getElementById("buildMenu")) {
        document.getElementById("buildMenu").remove();
      }
      showBuildZone(currentBuildingForMenu, buildingType);
    } else {
      showWarning("Недостаточно ресурсов или здание недоступно");
    }
  });

  return div;
}

function updateBuildMenu(menu, building) {
  const types = [
    { type: "warehouse", label: "Склад" },
    { type: "repairWorkshop", label: "Мастерская" },
    { type: "barracks", label: "Казарма" },
    { type: "turret", label: "Турель" },
    { type: "beacon", label: "Маяк" },
    { type: "base2", label: "База II" },
    { type: "barracks2", label: "Казарма II" },
    { type: "turret2", label: "Ракетная турель" },
    { type: "base3", label: "База III" },
    { type: "barracks3", label: "Казарма III" },
    { type: "turret3", label: "Лазерная турель" }
  ];

  types.forEach(({ type, label }) => {
    // 💥 Проверка доступности этапа
    if (canPlayerBuild(type)) {
      menu.appendChild(getMenuItem(type, label));
    }
  });
}

function showBuildingMenu(building) {
  if (building.owner !== playerId && !(gameMode === "single" && building.owner === "player")) return;

  clearBuildZones();

  const existing = document.getElementById("buildMenu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.id = "buildMenu";
  // Стили для красивого отображения сеткой
  menu.style.cssText = "position:fixed; background:rgba(0,0,0,0.85); border:1px solid #444; border-radius:8px; padding:10px; z-index:1000; display:flex; flex-wrap:wrap; gap:8px; max-width:260px; backdrop-filter:blur(4px);";
  document.body.appendChild(menu);

  // ✅ Разрешаем скролл меню на телефонах
  menu.addEventListener("touchmove", function(e) {
    e.stopPropagation();
  }, { passive: false });

  currentBuildingForMenu = building;
  updateBuildMenu(menu, building);

  buildingMenuOpened = true;

  suppressTouchClick = true;
  setTimeout(() => suppressTouchClick = false, 300);

  // === Вычисляем начальную позицию
  const screenPos = worldToScreen(building.x, building.y);
  let x = screenPos.x - 60;
  let y = screenPos.y + building.height * camera.scale / 2 + 5;

  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  // Безопасная первая коррекция
  x = Math.max(0, Math.min(x, window.innerWidth - 30));
  y = Math.max(0, Math.min(y, window.innerHeight - 45));

  // После добавления в документ — корректируем по реальному размеру меню
  setTimeout(() => {
    if (menu.offsetWidth && menu.offsetHeight) {
      if (x + menu.offsetWidth > window.innerWidth) {
        x = Math.max(0, window.innerWidth - menu.offsetWidth - 10);
      }
      if (y + menu.offsetHeight > window.innerHeight) {
        y = Math.max(0, window.innerHeight - menu.offsetHeight - 10);
      }
    }
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }, 0);
}


function clamp(value, min, max) { return Math.max(min, Math.min(value, max)); }

if (typeof playerBase !== 'undefined' && typeof aiBase !== 'undefined' && playerBase && aiBase && !gameState.capturePoints) {
  gameState.capturePoints = [];
  const playerPoints = createCapturePointsForBase(playerBase);
  const aiPoints = createCapturePointsForBase(aiBase);
  playerPoints.forEach(pos => {
    gameState.capturePoints.push({ x: pos.x, y: pos.y, width: 30, height: 30, color: "white", owner: null, turrets: [], turretSpawnCount: 0, waveSpawnInterval: null, turretSpawnScheduled: false });
  });
  aiPoints.forEach(pos => {
    gameState.capturePoints.push({ x: pos.x, y: pos.y, width: 30, height: 30, color: "white", owner: null, turrets: [], turretSpawnCount: 0, waveSpawnInterval: null, turretSpawnScheduled: false });
  });
}

async function startNeuralGame() {
  neuralAIActive = true;
  startAutoReloadModel(100000);
  const pres = document.getElementById("loadingScreen");
  if (pres) pres.style.display = "none";
  ["startButton", "pvpButton", "tutorialButton", "neuralButton"].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = "none";
  });
  const trainBtn = document.getElementById("trainNeuralAIButton");
  if (trainBtn) {
    trainBtn.addEventListener("click", () => {
      trainNeuralModel(lastNeuralAction, lastInputArray, lastGoldDelta, lastSiliconDelta, lastPlasmaDelta, lastWorkerCount, lastIdleWarehouseCount, lastWarehouseCount);
    });
  }
  const badBtn = document.getElementById("badDecisionButton");
  if (badBtn) badBtn.addEventListener("click", () => { penalizeBadDecision(); });
  
const resetBtn = document.getElementById("resetNeuralAIButton");
if (resetBtn) {
  resetBtn.addEventListener("click", async () => {
    const password = prompt("Введите пароль для сброса нейросети:");
    if (!password) return;

    console.log("[Reset] 🧹 Начинаем полную очистку модели...");

    try {
      // 1. Удаляем модель через TF.js API
      await tf.io.removeModel(LOCAL_MODEL_PATH);
      console.log("[Reset] ✅ Модель удалена через TF.js");
    } catch (err) {
      console.warn("[Reset] ⚠️ TF.js не смог удалить:", err.message);
    }

    // 2. Ядерный вариант: полное удаление базы IndexedDB
    try {
      console.log("[Reset] 💣 Удаляем всю базу tensorflowjs...");
      const databases = await indexedDB.databases();
      for (const db of databases) {
        if (db.name && db.name.includes("tensorflow")) {
          indexedDB.deleteDatabase(db.name);
          console.log("[Reset] 🗑 Удалена база:", db.name);
        }
      }
      indexedDB.deleteDatabase("tensorflowjs");
      indexedDB.deleteDatabase("tfjs-core");
      console.log("[Reset] ✅ База IndexedDB удалена");
    } catch (err) {
      console.error("[Reset] ❌ Ошибка при очистке IndexedDB:", err);
    }

    // 3. СРАЗУ перезагружаем страницу — все переменные в памяти сбросятся
    alert("✅ Модель полностью удалена! Перезагрузка...");
    location.reload();
  });
}

  gameStarted = true; gameMode = "neural";
  AIScheduler.start("neural");
  if (typeof initAILogic === "function") initAILogic(); 
  lastTime = performance.now();
  gameState.buildings = []; gameState.units = []; gameState.fragments = []; gameState.particles = []; gameState.resources = [];
  gameState.playerResources = { gold: 100, silicon: 100, plasma: 50 };
  gameState.aiResources = { gold: 100, silicon: 100, plasma: 50 };
  gameState.playerScore = 0;

  const m = 300;
  playerBase = new Building("base", "player", m, m);
  aiBase = new Building("base", "ai", worldWidth - m, worldHeight - m);
  playerBase.active = true; aiBase.active = true;
  gameState.buildings.push(playerBase, aiBase);
  generateResources(100);
  camera.offsetX = canvas.width / 2 - playerBase.x * camera.scale;
  camera.offsetY = canvas.height / 2 - playerBase.y * camera.scale;
  document.getElementById("controlsWrapper").style.display = "block";
  playerId = "player";
  requestAnimationFrame(gameLoop);
}

function initSinglePlayerBases() {
  const m = 200;
  const playerPos = getRandomBasePosition(m);
  playerBase = new Building("base", "player", playerPos.x, playerPos.y);
  const aiPos = getRandomBasePosition(m, playerBase);
  aiBase = new Building("base", "ai", aiPos.x, aiPos.y);
  gameState.buildings.push(playerBase, aiBase);
  camera.offsetX = canvas.width / 2 - playerBase.x * camera.scale;
  camera.offsetY = canvas.height / 2 - playerBase.y * camera.scale;
}

function startNewGame() {
  if (gameMode === "pvp") return;
  playerId = "player"; opponentId = null;
  initSinglePlayerBases();
  generateResources(Date.now());
  gameStarted = true; isPaused = false; lastTime = performance.now();
  gameLoopId = requestAnimationFrame(gameLoop);
  if (typeof initAILogic === "function") initAILogic();
  AIScheduler.start("single");
  if (!gameState.units.some(u => u.owner === "ai" && u.type === "fighter")) {
    setTimeout(() => {
      const fighter = getUnitFromPool("fighter", "ai", aiBase.x, aiBase.y);
      addUnit(fighter);
      const { spawn, target } = spawnAtBoundary(aiBase, 10);
      fighter.x = spawn.x; fighter.y = spawn.y;
      moveUnit(fighter, target.x, target.y, () => startFighterCycle(fighter));
    }, 30000);
  }
  const controlsWrapper = document.getElementById("controlsWrapper");
  if (controlsWrapper) {
    controlsWrapper.style.display = "block";
    setTimeout(() => { controlsWrapper.style.opacity = 1; }, 100);
  }
}

const imageCache = {};
const iconMap = {
  warehouse: "/src/models/warehouse.png", repairWorkshop: "/src/models/repairWorkshop.png",
  barracks: "/src/models/barracks.png", barracks2: "/src/models/barracks2.png", barracks3: "/src/models/barracks3.png",
  turret: "/src/models/turret.png", turret2: "/src/models/turret2.png", turret3: "/src/models/turret3.png",
  beacon: "/src/models/beacon.png", base: "/src/models/base.png", base2: "/src/models/base2.png", base3: "/src/models/base3.png"
};

function preloadImage(src) {
  const img = new Image();
  img.onload = () => { imageCache[src] = img; };
  img.src = src;
}

function openPerkMenu(slotIndex) {
  selectedSlotIndex = slotIndex;
  if (typeof perkMenuEl !== 'undefined' && perkMenuEl) perkMenuEl.style.display = "flex";
}

function startMatrixEffect() {
  const mCanvas = document.getElementById("matrixCanvas");
  if (!mCanvas) return;
  const mCtx = mCanvas.getContext("2d");
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%^&*()/\\";
  const fontSize = 16, columns = mCanvas.width / fontSize;
  const drops = Array.from({ length: Math.floor(columns) }, () => 1);
  function drawMatrix() {
    mCtx.fillStyle = "rgba(0, 0, 0, 0.05)";
    mCtx.fillRect(0, 0, mCanvas.width, mCanvas.height);
    mCtx.fillStyle = "#0f0"; mCtx.font = fontSize + "px monospace";
    for (let i = 0; i < drops.length; i++) {
      const text = letters.charAt(Math.floor(Math.random() * letters.length));
      mCtx.fillText(text, i * fontSize, drops[i] * fontSize);
      if (drops[i] * fontSize > mCanvas.height && Math.random() > 0.975) drops[i] = 0;
      drops[i]++;
    }
  }
  setInterval(drawMatrix, 50);
}
startMatrixEffect();



function animateLogoLetters() {
  const letters = document.querySelectorAll("#logoText .logo-letter");
  letters.forEach(letter => {
    const delay = Math.random() * 1000;
    setTimeout(() => { letter.style.opacity = 1; letter.style.transform = "translateY(0)"; }, delay);
  });
}
document.addEventListener("DOMContentLoaded", () => { animateLogoLetters(); });

function startPresentationTextAnimation() {
  const presentsEl = document.getElementById("presentsText");
  if (!presentsEl) return;
  const text = "presents....";
  let index = 0;
  const INITIAL_DELAY = 2000, LETTER_INTERVAL = 150, PRESENTATION_TOTAL_DURATION = 6000;
  setTimeout(() => {
    presentsEl.style.opacity = 1;
    const startTime = performance.now();
    const typingInterval = setInterval(() => {
      if (index < text.length) { presentsEl.textContent += text.charAt(index); index++; } 
      else {
        clearInterval(typingInterval);
        const elapsedTime = performance.now() - startTime + INITIAL_DELAY;
        const remainingTime = Math.max(0, PRESENTATION_TOTAL_DURATION - elapsedTime);
        setTimeout(() => {
          const presentation = document.getElementById("presentationScreen");
          if (presentation) {
            presentation.style.opacity = 0;
            presentation.addEventListener("transitionend", () => {
              presentation.style.display = "none";
              const loadingScreen = document.getElementById("loadingScreen");
              if (loadingScreen) loadingScreen.style.display = "flex";
            }, { once: true });
          }
        }, remainingTime);
      }
    }, LETTER_INTERVAL);
  }, INITIAL_DELAY);
}
startPresentationTextAnimation();

document.addEventListener("DOMContentLoaded", () => {
  const letters = document.querySelectorAll("#logoText .logo-letter");
  letters.forEach(letter => {
    const offsetX = (Math.random() - 0.5) * 100, offsetY = (Math.random() - 0.5) * 100;
    letter.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
    letter.style.opacity = 0;
    letter.style.transitionDelay = `${Math.random() * 1500}ms`;
  });
  setTimeout(() => {
    letters.forEach(letter => { letter.style.transform = "translate(0, 0)"; letter.style.opacity = 1; });
  }, 50);
});

// ============================================================
// ПЕРКИ: АКТИВАЦИЯ С СОВРЕМЕННЫМ ВИЗУАЛОМ
// ============================================================

// Глобальные переменные состояния перков

let activeReconTarget = null;
let reconConfirmCallback = null;
let reconCancelCallback = null;

// Кулдауны перков (в миллисекундах)
const SHOCK_COOLDOWN = 25000;
const BOMB_COOLDOWN = 45000;
const RECON_COOLDOWN = 20000;

const SHOCK_RADIUS = 180;
const BOMB_RADIUS = 140;
const BOMB_DELAY = 2000; // задержка перед взрывом
const BOMB_MAX_DAMAGE = 200;
const RECON_RADIUS = 250;
const RECON_DURATION = 12000;


// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

const availablePerks = [
  { id: "shock", name: "ЭМИ-удар", icon: "⚡", cooldown: 25000 },
  { id: "bomb", name: "Плазменная бомба", icon: "💣", cooldown: 45000 },
  { id: "recon", name: "Разведка", icon: "🛰️", cooldown: 20000 }
];

let equippedPerks = [null, null, null];
let perkCooldowns = [0, 0, 0];
let selectedSlotIndex = 0;
const perkMenuEl = document.getElementById("perkMenu");
const perkSlots = [...document.querySelectorAll(".perk-slot")];

function renderPerkMenu() {
  if (!perkMenuEl) return;
  perkMenuEl.innerHTML = "";
  availablePerks.forEach(perk => {
    const icon = document.createElement("div");
    icon.className = "perk-icon";
    icon.textContent = perk.icon;
    icon.title = perk.name;
    icon.onclick = () => {
      // Используем selectedSlotIndex вместо indexOf(null)
      if (selectedSlotIndex !== -1 && selectedSlotIndex < 3) {
        equippedPerks[selectedSlotIndex] = perk.id;
        updatePerkSlots();
        perkMenuEl.style.display = "none";
      }
    };
    perkMenuEl.appendChild(icon);
  });
}

function openPerkMenu(slotIndex) {
  selectedSlotIndex = slotIndex;
  renderPerkMenu(); // 🔥 ВЫЗЫВАЕМ РЕНДЕР МЕНЮ
  if (perkMenuEl) perkMenuEl.style.display = "flex";
}

function updatePerkSlots() {
  if (!perkSlots) return;
  perkSlots.forEach((slot, index) => {
    const perkId = equippedPerks[index];
    slot.innerHTML = "";
    slot.style.position = "relative";
    const icon = document.createElement("div");
    const perkData = availablePerks.find(perk => perk.id === perkId);
    if (perkData) {
      icon.textContent = perkData.icon;
      icon.style.fontSize = "22px";
      icon.style.opacity = "1";
    } else {
      icon.textContent = "+";
      icon.style.opacity = "0.2";
    }
    slot.appendChild(icon);
    
    let overlay = slot.querySelector(".perk-cooldown");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.classList.add("perk-cooldown");
      overlay.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);opacity:0;pointer-events:none;transition:opacity 0.2s linear;";
      slot.appendChild(overlay);
    }
    const remaining = Math.max(0, perkCooldowns[index] - Date.now());
    if (perkData && remaining > 0) {
      overlay.style.opacity = (remaining / perkData.cooldown).toFixed(2);
      slot.classList.remove("available");
    } else {
      overlay.style.opacity = "0";
      slot.classList.add("available");
    }
    
    // 🔥 ОБРАБОТЧИК КЛИКА
    slot.onclick = () => {
      if (perkId === "shock") activateShockPerk(index);
      else if (perkId === "bomb") activateBombPerk(index);
      else if (perkId === "recon") activateReconPerk(index);
      else openPerkMenu(index); // Если слот пустой — открываем меню
    };
  });
}

// 🔥 ВЫЗЫВАЕМ ПРИ ЗАГРУЗКЕ
window.addEventListener("load", () => {
  updatePerkSlots();
});

const neuralButton = document.getElementById("neuralButton");
if (neuralButton) {
  neuralButton.addEventListener("click", () => { startNeuralGame(); });
}

window.addEventListener("load", () => {
  resizeCanvas();
  const startButton = document.getElementById("startButton");
  if (startButton) {
    startButton.addEventListener("touchstart", (e) => {
      e.preventDefault();
      const loadingScreen = document.getElementById("loadingScreen");
      if (loadingScreen) loadingScreen.style.display = "none";
      if (gameMode !== "pvp") { gameMode = "single"; startNewGame(); }
    });
    startButton.addEventListener("click", () => {
      const loadingScreen = document.getElementById("loadingScreen");
      if (loadingScreen) loadingScreen.style.display = "none";
      if (gameMode !== "pvp") { gameMode = "single"; startNewGame(); }
    });
  }
});

// ============================================================
// Принудительное отключение проверки ориентации на ПК
// ============================================================
window.addEventListener("load", () => {
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  if (!isMobile) {
    const warning = document.getElementById("orientationWarning");
    if (warning) {
      warning.style.display = "none";
    }
    document.body.style.overflow = "auto"; // Разрешаем скролл на ПК
  }
});

// ============================================================
// ФУНКЦИИ НАЙМА ЮНИТОВ (ПОЛНЫЙ ОРИГИНАЛЬНЫЙ КОД)
// ============================================================

function getMissingResources(cost, owner) {
  const resources = getResourcesByOwner(owner);
  const reserved = typeof getReservedResources === "function" ? getReservedResources(owner) : { gold: 0, silicon: 0, plasma: 0 };

  return {
    gold: Math.ceil(Math.max(0, cost.gold + reserved.gold - resources.gold)),
    silicon: Math.ceil(Math.max(0, cost.silicon + reserved.silicon - resources.silicon)),
    plasma: Math.ceil(Math.max(0, cost.plasma + reserved.plasma - resources.plasma))
  };
}

function hireWorkerForPlayer(warehouse) {
  if (!warehouse.active) {
    showWarning("Здание еще не активно!");
    return;
  }

  const res = getResourcesByOwner(playerId);

  if (res.gold < WORKER_COST.gold ||
      res.silicon < WORKER_COST.silicon ||
      res.plasma < WORKER_COST.plasma) {
    const missing = getMissingResources(WORKER_COST, playerId);
    showWarning(`Не хватает: золото — ${missing.gold}, кремний — ${missing.silicon}, плазма — ${missing.plasma}`);
    return;
  }

  if (warehouse.workers >= 5) {
    showWarning("Достигнут лимит рабочих для склада");
    return;
  }

  res.gold -= WORKER_COST.gold;
  res.silicon -= WORKER_COST.silicon;
  res.plasma -= WORKER_COST.plasma;
  updateResourceUI();

  warehouse.workers++;

  const { spawn, target } = spawnAtBoundary(warehouse, 10);
  const worker = getUnitFromPool("worker", playerId, spawn.x, spawn.y);

  worker.carrying = 0;
  worker.delivering = false;
  worker.carriedResourceToken = null;
  worker.assignedResource = null;
  worker.assignedResourceType = null;
  worker.homeWarehouse = warehouse;

  gameState.units.push(worker);
  moveUnit(worker, target.x, target.y, () => startWorkerCycle(worker, warehouse));

  if (gameMode === "pvp" && typeof sendPvpAction === "function") {
    sendPvpAction({
      type: "hire",
      unitType: "worker",
      x: worker.x,
      y: worker.y,
      playerId: playerId,
      warehouseId: warehouse.id
    });
  }
}

function hireRepairmanForPlayer(workshop) {
  if (!workshop.active) {
    showWarning("Здание еще не активно!");
    return;
  }
  if (workshop.repairman >= workshop.capacity) {
    showWarning("Максимальное количество ремонтников для мастерской достигнуто");
    return;
  }

  const res = getResourcesByOwner(playerId);

  if (res.gold < REPAIRMAN_COST.gold ||
      res.silicon < REPAIRMAN_COST.silicon ||
      res.plasma < REPAIRMAN_COST.plasma) {
    const missing = getMissingResources(REPAIRMAN_COST, playerId);
    showWarning(`Не хватает: золото — ${missing.gold}, кремний — ${missing.silicon}, плазма — ${missing.plasma}`);
    return;
  }

  res.gold -= REPAIRMAN_COST.gold;
  res.silicon -= REPAIRMAN_COST.silicon;
  res.plasma -= REPAIRMAN_COST.plasma;
  updateResourceUI();

  workshop.repairman++;

  const { spawn, target } = spawnAtBoundary(workshop, 10);
  const repairman = getUnitFromPool("repairman", playerId, spawn.x, spawn.y);
  repairman.homeWorkshop = workshop;

  gameState.units.push(repairman);
  moveUnit(repairman, target.x, target.y, () => startRepairmanCycle(repairman));

  if (gameMode === "pvp" && typeof sendPvpAction === "function") {
    sendPvpAction({
      type: "hire",
      unitType: "repairman",
      x: repairman.x,
      y: repairman.y,
      playerId: playerId,
      workshopId: workshop.id
    });
  }
}

function hireFighterForPlayer(barracks) {
  if (barracks.owner !== playerId) {
    showWarning("Это чужое здание!");
    return;
  }

  if (!barracks.active) {
    showWarning("Здание еще не активно!");
    return;
  }

  if (!barracks.productionQueue) {
    barracks.productionQueue = [];
  }

  const missing = getMissingResources(FIGHTER_COST, playerId);
  const res = getResourcesByOwner(playerId);

  if (res.gold < FIGHTER_COST.gold ||
      res.silicon < FIGHTER_COST.silicon ||
      res.plasma < FIGHTER_COST.plasma) {
    showWarning(`Не хватает: золото — ${missing.gold}, кремний — ${missing.silicon}, плазма — ${missing.plasma}`);
    return;
  }

  if (barracks.productionQueue.length >= barracks.productionLimit) {
    showWarning("Очередь производства заполнена.");
    return;
  }

  res.gold -= FIGHTER_COST.gold;
  res.silicon -= FIGHTER_COST.silicon;
  res.plasma -= FIGHTER_COST.plasma;
  updateResourceUI();

  const productionTime = 6000;
  const lastOrder = barracks.productionQueue[barracks.productionQueue.length - 1];

  let timeStart = performance.now();
  if (lastOrder) {
    timeStart = lastOrder.timeStart + lastOrder.productionTime;
  }

  const order = {
    unitType: "fighter",
    timeStart: timeStart,
    productionTime: productionTime
  };

  barracks.productionQueue.push(order);
}

function hireAssaultForPlayer(barracks2) {
  if (barracks2.owner !== playerId) {
    showWarning("Это чужое здание!");
    return;
  }

  if (!barracks2.active) {
    showWarning("Здание еще не активно!");
    return;
  }

  const ASSAULT_COST = { gold: 23, silicon: 26, plasma: 12 };

  if (!barracks2.productionQueue) {
    barracks2.productionQueue = [];
  }

  const missing = getMissingResources(ASSAULT_COST, playerId);
  const res = getResourcesByOwner(playerId);

  if (res.gold < ASSAULT_COST.gold ||
      res.silicon < ASSAULT_COST.silicon ||
      res.plasma < ASSAULT_COST.plasma) {
    showWarning(`Не хватает: золото — ${missing.gold}, кремний — ${missing.silicon}, плазма — ${missing.plasma}`);
    return;
  }

  if (barracks2.productionQueue.length >= barracks2.productionLimit) {
    showWarning("Очередь производства заполнена.");
    return;
  }

  res.gold -= ASSAULT_COST.gold;
  res.silicon -= ASSAULT_COST.silicon;
  res.plasma -= ASSAULT_COST.plasma;
  updateResourceUI();

  barracks2.fighters = (barracks2.fighters || 0) + 1;

  const productionTime = 12000;
  let timeStart = performance.now();
  const lastOrder = barracks2.productionQueue[barracks2.productionQueue.length - 1];
  if (lastOrder) {
    timeStart = lastOrder.timeStart + lastOrder.productionTime;
  }

  const order = {
    unitType: "assault",
    timeStart: timeStart,
    productionTime: productionTime
  };

  barracks2.productionQueue.push(order);
}

function hireEliteForPlayer(barracks3) {
  if (barracks3.owner !== playerId) {
    showWarning("Это чужое здание!");
    return;
  }

  if (!barracks3.active) {
    showWarning("Здание еще не активно!");
    return;
  }

  const ELITE_COST = { gold: 58, silicon: 73, plasma: 36 };

  if (!barracks3.productionQueue) {
    barracks3.productionQueue = [];
  }

  const missing = getMissingResources(ELITE_COST, playerId);
  const res = getResourcesByOwner(playerId);

  if (res.gold < ELITE_COST.gold ||
      res.silicon < ELITE_COST.silicon ||
      res.plasma < ELITE_COST.plasma) {
    showWarning(`Не хватает: золото — ${missing.gold}, кремний — ${missing.silicon}, плазма — ${missing.plasma}`);
    return;
  }

  if (barracks3.productionQueue.length >= barracks3.productionLimit) {
    showWarning("Очередь производства заполнена.");
    return;
  }

  res.gold -= ELITE_COST.gold;
  res.silicon -= ELITE_COST.silicon;
  res.plasma -= ELITE_COST.plasma;
  updateResourceUI();

  barracks3.fighters = (barracks3.fighters || 0) + 1;

  const productionTime = 18000;
  let timeStart = performance.now();
  const lastOrder = barracks3.productionQueue[barracks3.productionQueue.length - 1];
  if (lastOrder) {
    timeStart = lastOrder.timeStart + lastOrder.productionTime;
  }

  const order = {
    unitType: "elite",
    timeStart: timeStart,
    productionTime: productionTime
  };

  barracks3.productionQueue.push(order);
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

// ============================================================
// ФУНКЦИЯ ПОКАЗА ПРЕДУПРЕЖДЕНИЙ
// ============================================================

function showWarning(message) {
  const warningDiv = document.createElement("div");
  warningDiv.innerText = message;
  warningDiv.style.position = "fixed";
  warningDiv.style.top = "20px";
  warningDiv.style.right = "20px";
  warningDiv.style.background = "rgba(255, 0, 0, 0.8)";
  warningDiv.style.color = "white";
  warningDiv.style.padding = "10px 15px";
  warningDiv.style.borderRadius = "5px";
  warningDiv.style.zIndex = "10000";
  warningDiv.style.fontFamily = "Arial, sans-serif";
  warningDiv.style.fontSize = "14px";
  warningDiv.style.boxShadow = "0 2px 8px rgba(0,0,0,0.3)";
  document.body.appendChild(warningDiv);
  setTimeout(() => {
    if (warningDiv.parentNode) {
      warningDiv.remove();
    }
  }, 2000);
}