let recentCombatSuccesses = 0;
let recentCombatFailures = 0;
let lastRewardedAction = null;
let combatEvaluated = false;
let confirmedStrategies = [];
let pendingRewardCheck = [];
let lastInputArray = null;
let lastGoldDelta = 0;
let lastSiliconDelta = 0;
let lastPlasmaDelta = 0;
let lastWorkerCount = 0;
let lastIdleWarehouseCount = 0;
let lastWarehouseCount = 0;
let model = null;
let isTraining = false;
let trainingQueue = [];
let lastUnitTypeHired = null;
let repeatHiresInRow = 0;
let spamPenaltyCount = 0;
let lastEconomySnapshot = {
  gold: 0,
  silicon: 0,
  plasma: 0,
  time: performance.now()
};
let nextDecisionDelay = 5000;
let lastInput = null;
let lastActionIndex = null;
let lastNeuralAction = null;
let idlePenaltyCount = 0;
let recentAutoTrainFlag = 0;
let aiBuildQueue = [];
let trainingData = {
  inputs: [],
  outputs: []
};
let lastActionRepeatCount = 0;
let lastActionRepeatType = null;
let isNeuralTraining = false;

const REPLAY_BUFFER_SIZE = 2000;
const experienceReplayBuffer = [];

function storeExperience(state, actionIndex, reward, nextState) {
  if (experienceReplayBuffer.length >= REPLAY_BUFFER_SIZE) {
    experienceReplayBuffer.shift();
  }
  experienceReplayBuffer.push({ state, actionIndex, reward, nextState });
}

let lastTrainTime = 0;
async function trainFromReplayBatch() {
  const now = performance.now();
  
  // 🔥 ДОБАВЛЕНО: Проверка глобального флага isNeuralTraining
  if (isNeuralTraining || now - lastTrainTime < 3000 || experienceReplayBuffer.length < 64) {
    return; 
  }
  
  isNeuralTraining = true; // 🔒 ЗАХВАТЫВАЕМ ЗАМОК
  lastTrainTime = now;

  const batch = [];
  for (let i = 0; i < 64; i++) {
    batch.push(experienceReplayBuffer[Math.floor(Math.random() * experienceReplayBuffer.length)]);
  }

  const states = tf.tensor2d(batch.map(exp => exp.state));
  
  // Формируем целевые векторы ПРАВИЛЬНО
  const targets = batch.map(exp => {
    const targetVec = new Array(actions.length).fill(0.05); // Базовый фон (низкая вероятность)
    
    // 🔥 ИСПРАВЛЕНИЕ: Если награда положительная -> стремимся к 0.9. Если отрицательная -> к 0.01
    const targetValue = exp.reward > 0 ? 0.9 : 0.01;
    
    targetVec[exp.actionIndex] = targetValue; 
    return targetVec;
  });
  const targetTensor = tf.tensor2d(targets);

  try {
    await neuralModel.fit(states, targetTensor, { epochs: 1, batchSize: 32, verbose: 0 });
  } catch (e) {
    console.error("[NeuralAI] Ошибка пакетного обучения:", e);
  } finally {
    states.dispose();
    targetTensor.dispose();
    isNeuralTraining = false; // 🔓 ОТПУСКАЕМ ЗАМОК
  }
}

console.log("[NeuralAI] Загружен и активен (Режим: Настоящее обучение с подкреплением)");
let previousEnemyCount = 0;
let neuralModel = null;
let recentThreats = [];
let idleUnitsCount = 0;

window.addEventListener("load", () => {
  if (typeof initNeuralModel === "function") {
    console.log("[Neural] Инициализация модели...");
    initNeuralModel();
  } else {
    console.error("[Neural] initNeuralModel не определена при загрузке страницы");
  }
});

const LOCAL_MODEL_PATH = 'indexeddb://neural-ai-model';
const actions = [
  "attack", "defend", "build", "idle",
  "flank", "ambush", "retreat", "protect",
  "strikeClusters", "attackWeakSpot", "fallback", 
  "scout", "regroup", "harass", "expand",
  "hireFighter", "hireAssault", "hireElite", 
  "counterAttack", "mobilizeZone", "opportunisticStrike",
  "pursueRetreating", "isolateIntruders", "reinforceFlank",
  "avoidZone", "preemptiveStrike", "scoutThreatZone",
  "longFlank", "deepStrike"  // 🔥 НОВЫЕ ДЕЙСТВИЯ
];

// Стало: 82 элемента, 29 действий

// В normalizeInputs добавь обработку новых индексов:
function normalizeInputs(inputArray) {
  return inputArray.map((val, index) => {
    if (index <= 10) return val / 1000;
    if (index <= 30) return val / 100;
    if (index <= 60) return val / 10;
    if (index <= 70) return (val + 1000) / 2000;
    if (index <= 77) return val / 1000;
    // 🔥 Новые признаки (78-82): все уже нормализованы 0-1
    return val;
  });
}

let actionUsageStats = {};
actions.forEach(a => actionUsageStats[a] = 0);

function getValidActionMask() {
  const mask = new Array(actions.length).fill(1);

  const hasBarracks = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks");
  const hasBarracks2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks2");
  const hasBarracks3 = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks3"); // 🔥 ДОБАВЛЕНО
  const hasBeacon = gameState.buildings.some(b => b.owner === "ai" && b.type === "beacon");

  if (!hasBarracks) mask[actions.indexOf("hireFighter")] = 0;
  if (!hasBarracks2) mask[actions.indexOf("hireAssault")] = 0;
  if (!hasBarracks3) mask[actions.indexOf("hireElite")] = 0; // 🔥 ДОБАВЛЕНО: блокируем hireElite без barracks3
  if (!hasBeacon) mask[actions.indexOf("expand")] = 0;
  const aiRes = gameState.aiResources || { gold: 0, silicon: 0, plasma: 0 };
  const aiWorkersCount = gameState.units.filter(u => u.owner === "ai" && u.type === "worker").length;
  const aiWarehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse");
  const idleWarehousesCount = aiWarehouses.filter(w => !w.workers || w.workers < (w.maxDeliveryWorkers || 5)).length;
  const hasExcessResources = aiRes.gold > 80 || aiRes.silicon > 80;
  const canAffordWorker = aiRes.gold >= (WORKER_COST?.gold || 4) && aiRes.silicon >= (WORKER_COST?.silicon || 6);
  const needsMoreWorkers = aiWorkersCount < aiWarehouses.length;

  if (hasExcessResources && (canAffordWorker || idleWarehousesCount > 0 || needsMoreWorkers)) {
    mask[actions.indexOf("idle")] = 0;
  }

  const isUnderAttack = gameState.buildings.some(b =>
    b.owner === "ai" && b.health < b.maxHealth * 0.9 &&
    gameState.units.some(u => u.owner === "player" && Math.hypot(u.x - b.x, u.y - b.y) < 300)
  );
  if (isUnderAttack) {
    mask[actions.indexOf("idle")] = 0;
    mask[actions.indexOf("build")] = 0;
  }

  const armyCount = gameState.units.filter(u => u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type)).length;
  if (armyCount === 0) {
    const combatActionsToMask = ["attack", "flank", "ambush", "strikeClusters", "attackWeakSpot", "counterAttack", "opportunisticStrike", "pursueRetreating", "isolateIntruders", "reinforceFlank", "preemptiveStrike"];
    combatActionsToMask.forEach(action => {
      const idx = actions.indexOf(action);
      if (idx !== -1) {
        mask[idx] = 0;
      }
    });
  }

  return mask;
}
										 
// ============================================================
// УМНОЕ ДОБАВЛЕНИЕ УГРОЗ (с защитой от дубликатов)
// ============================================================
function addSmartThreat(x, y, type, severity) {
  const now = Date.now();
  
  // 🔥 Уменьшили радиус дедупликации с 30 до 15 пикселей
  // 🔥 Уменьшили окно с 5000 до 3000 мс
  const isDuplicate = recentThreats.some(t => 
    Math.hypot(t.x - x, t.y - y) < 15 && 
    (now - t.timestamp) < 3000
  );
  
  if (!isDuplicate) {
    recentThreats.push({ x, y, timestamp: now, type, severity });
  }
}
// СТРАТЕГИЧЕСКОЕ СКАНИРОВАНИЕ: Запись оборонительных точек игрока
// ============================================================
let lastStrategicScanTime = 0;

function scanAndRecordPlayerDefenses() {
  const now = Date.now();
  if (now - lastStrategicScanTime < 2000) return;
  lastStrategicScanTime = now;

  // 🔥 АДАПТИВНЫЙ РАДИУС: 15-20% от размера мира
  const scanRadius = Math.min(worldWidth, worldHeight) * 0.18; // ~380 пикселей для твоего мира

  const aiObservers = [
    ...gameState.buildings.filter(b => b.owner === "ai" && b.active),
    ...gameState.units.filter(u => u.owner === "ai")
  ];

  aiObservers.forEach(observer => {
    const queryRect = {
      x: observer.x - scanRadius,
      y: observer.y - scanRadius,
      width: scanRadius * 2,
      height: scanRadius * 2
    };

    const nearbyEntities = quadtree ? quadtree.query(queryRect) : [];

    nearbyEntities.forEach(entity => {
      if (entity.owner === "player" && entity.health > 0) {
        const dist = Math.hypot(entity.x - observer.x, entity.y - observer.y);
        
        if (dist <= scanRadius) {
          let severity = 15;
          let type = "unit_presence";

          if (entity.type?.startsWith("turret")) { 
            severity = 90;
            type = "heavy_defense"; 
          } else if (entity.type === "base" || entity.type?.startsWith("barracks")) { 
            severity = 70;
            type = "strategic_building"; 
          } else if (entity.type === "elite" || entity.type === "assault") { 
            severity = 50;
            type = "heavy_unit"; 
          }

          addSmartThreat(entity.x, entity.y, type, severity);
        }
      }
    });
  });

  cleanUpRecentThreats();
}

// Убедись, что эта функция очистки существует (если её нет, добавь):
function cleanUpRecentThreats() {
  const now = Date.now();
  recentThreats = recentThreats.filter(t => now - t.timestamp < 30000);
}

function applyMaskToLogits(logits, mask) {
  return logits.map((logit, i) => mask[i] === 0 ? -1e9 : logit);
}

function sampleActionWithTemperature(logits, mask, temperature = 1.2) {
  const maskedLogits = applyMaskToLogits(logits, mask);
  const scaled = maskedLogits.map(x => x / temperature);
  const maxLogit = Math.max(...scaled);
  const exps = scaled.map(x => Math.exp(x - maxLogit));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map(e => e / sum);

  const rand = Math.random();
  let cumulative = 0;
  for (let i = 0; i < probs.length; i++) {
    cumulative += probs[i];
    if (rand <= cumulative) return i;
  }
  return probs.length - 1;
}

function createModel() {
  const model = tf.sequential();
  model.add(tf.layers.dense({ inputShape: [82], units: 128, activation: 'relu' }));
  model.add(tf.layers.dropout({ rate: 0.1 }));
  model.add(tf.layers.dense({ units: 128, activation: 'relu' }));
  model.add(tf.layers.dense({ units: 64, activation: 'relu' }));
  model.add(tf.layers.dense({ units: actions.length, activation: 'linear' }));

  model.compile({
    optimizer: tf.train.adam(0.001),
    loss: 'meanSquaredError'
  });
  return model;
}

async function initNeuralModel() {
  console.log("[Neural] Инициализация локальной модели...");
  try {
    neuralModel = await tf.loadLayersModel(LOCAL_MODEL_PATH);
    neuralModel.compile({ optimizer: tf.train.adam(0.001), loss: "meanSquaredError" });
    console.log("[Neural] ✅ Локальная модель успешно загружена из браузера");
  } catch (e) {
    console.log("[Neural] Сохраненная модель не найдена. Создаем новую...");
    neuralModel = createModel();
    await saveModelToServer(neuralModel);
    console.log("[Neural] ✅ Новая модель создана и сохранена локально");
  }
}

function startAutoReloadModel(intervalMs = 60000) {
  console.log("[Neural] Авто-перезагрузка с сервера отключена (локальный режим).");
}

let lastDecisionTime = 0;

function splitIntoGroups(units, size = 4) {
  const groups = [];
  for (let i = 0; i < units.length; i += size) groups.push(units.slice(i, i + size));
  return groups;
}

function findNearestEnemyTarget(unit) {
  const possibleTargets = [...gameState.units.filter(u => u.owner !== unit.owner), ...gameState.buildings.filter(b => b.owner !== unit.owner)];
  if (possibleTargets.length === 0) return null;
  let best = null, bestDist = Infinity;
  for (const target of possibleTargets) {
    const d = Math.hypot(target.x - unit.x, target.y - unit.y);
    if (d < bestDist) { bestDist = d; best = target; }
  }
  return best;
}

const aiPerfStats = { count: 0, totalTime: 0, maxTime: 0 };

function updateNeuralAI() {
  // 🔥 ДОБАВЬ ЭТУ СТРОКУ В САМОЕ НАЧАЛО:
  scanAndRecordPlayerDefenses();

  combatEvaluated = false;
  const militaryCount = gameState.units.filter(u => u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type)).length;

  if (!neuralModel || performance.now() - lastDecisionTime < nextDecisionDelay) return;

  if (!Array.isArray(gameState.units) || !Array.isArray(gameState.buildings) || !Array.isArray(gameState.resources)) {
    console.warn("[NeuralAI] Игровое состояние ещё не готово");
    return;
  }

  const perfStart = performance.now();

  const aiBases = gameState.buildings.filter(b => b.owner === "ai" && b.type === "base");
  const playerBases = gameState.buildings.filter(b => b.owner === "player" && b.type === "base");

  if (aiBases.length === 0) {
    console.warn("[NeuralAI] 💀 Базы ИИ уничтожены. Поражение. Финальный штраф и остановка.");
    if (lastInputArray && lastNeuralAction && actions.includes(lastNeuralAction)) {
      penalizeBadDecision();
    }
    if (neuralModel) {
      saveModelToServer(neuralModel).then(() => {
        console.log("[NeuralAI] 💾 Модель сохранена после поражения");
      });
    }
    neuralAIActive = false;
    gameState.gameEnded = true;
    return;
  }

  if (playerBases.length === 0) {
    console.log("[NeuralAI] 🏆 Базы игрока уничтожены. Победа ИИ! ФИНАЛЬНОЕ ПОощРЕНИЕ!");
    if (lastInputArray && lastNeuralAction && actions.includes(lastNeuralAction)) {
      const victoryBoost = 2.0;
      const index = actions.indexOf(lastNeuralAction);
      const output = actions.map((_, i) => i === index ? victoryBoost : 0.01);
      console.log(`[NeuralAI] 🏆 Победа! Усиленное поощрение для '${lastNeuralAction}'`);
      safePushTraining({
        inputs: lastInputArray,
        targetOverride: output,
        action: lastNeuralAction,
        info: "[victory_reward]"
      });
      processTrainingQueue();
    }
    neuralAIActive = false;
    gameState.gameEnded = true;
    return;
  }

  lastDecisionTime = performance.now();
  const now = performance.now();
  const aiBase = aiBases[0];
  const hasBase2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "base2");
  const aiUnits = gameState.units.filter(u => u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type));
  const enemyUnits = gameState.units.filter(u => u.owner === "player");
  const currentEnemyCount = enemyUnits.length;

  const aiRes = gameState.aiResources || {};
  const aiFighters = aiUnits.filter(u => u.type === "fighter").length;
  const aiAssaults = aiUnits.filter(u => u.type === "assault").length;
  const aiElites = aiUnits.filter(u => u.type === "elite").length;
  const totalResources = (aiRes.gold || 0) + (aiRes.silicon || 0) + (aiRes.plasma || 0);
  const aiBaseHealth = aiBase.health;
  const aiBaseCount = aiBases.length;

  const outOfRangeBuildings = gameState.buildings.filter(b => b.owner !== "ai" || !isInBuildableRadius(b.x, b.y, "ai")).length;
  const hasBarracks3 = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks3");
  const hasBase3 = gameState.buildings.some(b => b.owner === "ai" && b.type === "base3");
  const hasTurret2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "turret2");
  const hasTurret3 = gameState.buildings.some(b => b.owner === "ai" && b.type === "turret3");
  const hasBarracks2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks2");
  const hasWarehouse = gameState.buildings.some(b => b.owner === "ai" && b.type === "warehouse");
  const enemyTurrets = gameState.buildings.filter(b => b.owner === "player" && b.type.startsWith("turret")).length;
  const unitCapReached = aiUnits.length >= 8;
  const nearestEnemyDistance = enemyUnits.length > 0 ? Math.min(...enemyUnits.map(e => Math.hypot(e.x - aiBase.x, e.y - aiBase.y))) : 9999;

  const enemyIsNear = nearestEnemyDistance < 200;
  const baseUnderAttackRecently = now - (aiBase.lastDamagedAt || 0) < 10000 ? 1 : 0;
  const numberOfClusters = gameState.buildings.filter(b => b.owner === "ai" && (b.type === "beacon" || b.type === "warehouse")).length;
  const lastBuildTimeAgo = now - (gameState.lastAiBuildTime || now);
  const timeSinceLastBuild = Math.min(lastBuildTimeAgo / 20000, 1);

  const enemyFighters = Array.isArray(gameState.units) ? gameState.units.filter(u => u.owner === "player" && u.type === "fighter").length : 0;
  const enemyAssaults = Array.isArray(enemyUnits) ? enemyUnits.filter(u => u.type === "assault").length : 0;
  const enemyElites = Array.isArray(enemyUnits) ? enemyUnits.filter(u => u.type === "elite").length : 0;
  const enemyBases = Array.isArray(gameState.buildings) ? gameState.buildings.filter(b => b.owner === "player" && b.type === "base").length : 0;
  const enemyBeacons = Array.isArray(gameState.buildings) ? gameState.buildings.filter(b => b.owner === "player" && b.type === "beacon").length : 0;
  const enemyWarehouses = Array.isArray(gameState.buildings) ? gameState.buildings.filter(b => b.owner === "player" && b.type === "warehouse").length : 0;
  const enemyClusters = enemyBeacons + enemyWarehouses;

  let resourcesNearBase = 0;
  if (aiBase && Array.isArray(gameState.resources)) {
    resourcesNearBase = gameState.resources.some(res => Math.sqrt((res.x - aiBase.x)**2 + (res.y - aiBase.y)**2) < 300 && res.amount > 0) ? 1 : 0;
  }

  const buildsRecent = gameState.recentBuilds.filter(b =>
    b.owner === "ai" && performance.now() - b.time < 5000
  ).length;

  gameState.recentLosses = (gameState.recentLosses || []).filter(b => performance.now() - b.time < 13000);
  const lostBuildingsRecent = gameState.recentLosses.filter(b =>
    b.owner === "ai" && performance.now() - b.time < 5000
  ).length;

  let fogNearBase = 0;
  if (aiBase && Array.isArray(gameState.fog)) {
    fogNearBase = gameState.fog.some(f => Math.sqrt((f.x - aiBase.x)**2 + (f.y - aiBase.y)**2) < 200) ? 1 : 0;
  }

  let avgDistanceBetweenUnits = 0;
  if (aiUnits.length > 1) {
    let totalDistance = 0, count = 0;
    for (let i = 0; i < aiUnits.length; i++) {
      for (let j = i + 1; j < aiUnits.length; j++) {
        totalDistance += Math.hypot(aiUnits[i].x - aiUnits[j].x, aiUnits[i].y - aiUnits[j].y);
        count++;
      }
    }
    avgDistanceBetweenUnits = totalDistance / count;
  }

  let enemyDensity = 0;
  if (enemyUnits.length > 0) {
    const bounds = { minX: Math.min(...enemyUnits.map(e => e.x)), maxX: Math.max(...enemyUnits.map(e => e.x)), minY: Math.min(...enemyUnits.map(e => e.y)), maxY: Math.max(...enemyUnits.map(e => e.y)) };
    const densityArea = Math.max((bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY), 10000);
    enemyDensity = enemyUnits.length / densityArea;
  }

  const trainingProgress = trainingData.inputs.length;
  const recentAutoTrain = recentAutoTrainFlag > 0 ? 1 : 0;
  const hasBuildQueue = Array.isArray(aiBuildQueue) && aiBuildQueue.length > 0 ? 1 : 0;
  const buildQueueLength = Array.isArray(aiBuildQueue) ? aiBuildQueue.length : 0;
  const activeAttackCommands = aiUnits.filter(u => Array.isArray(u.commandQueue) && u.commandQueue.some(c => c.type === "attack")).length;
  const activeDefendCommands = aiUnits.filter(u => Array.isArray(u.commandQueue) && u.commandQueue.some(c => c.type === "move" && aiBase && Math.hypot(c.x - aiBase.x, c.y - aiBase.y) < 100)).length;

  let goldDelta = 0, siliconDelta = 0, plasmaDelta = 0;
  const dt = (now - lastEconomySnapshot.time) / 1000;
  if (dt > 0 && isFinite(aiRes.gold) && isFinite(lastEconomySnapshot.gold)) {
    goldDelta = (aiRes.gold - lastEconomySnapshot.gold) / dt;
    siliconDelta = (aiRes.silicon - lastEconomySnapshot.silicon) / dt;
    plasmaDelta = (aiRes.plasma - lastEconomySnapshot.plasma) / dt;
  }
  lastEconomySnapshot = { gold: aiRes.gold || 0, silicon: aiRes.silicon || 0, plasma: aiRes.plasma || 0, time: now };

  const hasBarracks = Array.isArray(gameState.buildings) && gameState.buildings.some(b => b.owner === "ai" && (b.type === "barracks" || b.type === "barracks2"));
  const hasWorkshop = Array.isArray(gameState.buildings) && gameState.buildings.some(b => b.owner === "ai" && b.type === "repairWorkshop");
  const hasBeacon = Array.isArray(gameState.buildings) && gameState.buildings.some(b => b.owner === "ai" && b.type === "beacon");
  const hasTurrets = Array.isArray(gameState.buildings) && gameState.buildings.some(b => b.owner === "ai" && b.type?.startsWith("turret"));
  const needsRepairs = Array.isArray(gameState.buildings) && gameState.buildings.some(b => b.owner === "ai" && b.health < b.maxHealth * 0.8);
  const isUnderAttack = Array.isArray(gameState.units) && gameState.units.some(u => u.owner === 'ai' && u.underAttack);

  const warehouseCount = gameState.buildings.filter(b => b.type === "warehouse" && b.owner === "ai").length;
  const workerCount = gameState.units.filter(u => u.type === "worker" && u.owner === "ai").length;
  const idleWarehouseCountLocal = gameState.buildings.filter(b => b.type === "warehouse" && b.owner === "ai" && (!b.workers || b.workers === 0)).length;
  const enoughWorkers = workerCount >= Math.max(2, warehouseCount);
  const militaryNeed = militaryCount < 5;
  const idleUnitsCountLocal = gameState.units.filter(u => u.owner === "ai" && (!u.commandQueue || u.commandQueue.length === 0)).length;

  const inputArray = [
    aiUnits.length, enemyUnits.length, aiFighters, aiAssaults, aiElites, totalResources,
    aiRes.gold || 0, aiRes.silicon || 0, aiRes.plasma || 0, aiBaseHealth, aiBaseCount,
    hasBarracks ? 1 : 0, hasBarracks2 ? 1 : 0, hasTurrets ? 1 : 0, hasWarehouse ? 1 : 0,
    hasBeacon ? 1 : 0, hasBase2 ? 1 : 0, hasWorkshop ? 1 : 0, hasTurret2 ? 1 : 0,
    unitCapReached ? 1 : 0, enemyIsNear ? 1 : 0, Math.floor(lastBuildTimeAgo / 1000),
    nearestEnemyDistance, baseUnderAttackRecently, numberOfClusters, idleUnitsCountLocal,
    outOfRangeBuildings, enemyTurrets, enemyFighters, enemyElites, avgDistanceBetweenUnits,
    enemyDensity, idlePenaltyCount, fogNearBase, resourcesNearBase, buildsRecent,
    lostBuildingsRecent, trainingProgress, recentAutoTrain, hasBuildQueue, buildQueueLength,
    activeAttackCommands, activeDefendCommands,
    Math.max(-1, Math.min(1, goldDelta / 10)), Math.max(-1, Math.min(1, siliconDelta / 10)), Math.max(-1, Math.min(1, plasmaDelta / 10)),
    warehouseCount / 10, workerCount / 20, idleWarehouseCountLocal / 10,
    hasBarracks ? 1 : 0, hasWorkshop ? 1 : 0, hasBeacon ? 1 : 0, hasTurrets ? 1 : 0,
    enoughWorkers ? 1 : 0, needsRepairs ? 1 : 0, militaryNeed ? 1 : 0, isUnderAttack ? 1 : 0, timeSinceLastBuild,
    ((goldDelta + siliconDelta + plasmaDelta) / 3) < 0.1 ? 1 : 0,
    Math.min((enemyUnits.length / (aiFighters + 1)) * (enemyIsNear ? 1.5 : 1), 5),
    Math.min(warehouseCount > 0 ? workerCount / warehouseCount : 0, 3),
    (enemyIsNear && !hasTurrets) ? 1 : 0,
    Math.min((militaryCount + 1) / (enemyUnits.length + 1), 3),
    aiBaseHealth < (aiBase.maxHealth * 0.6) ? 1 : 0,
    idleUnitsCountLocal > 0 ? 1 : 0,
    (aiBaseCount < 2 && totalResources < 600) ? 1 : 0,
    (numberOfClusters > 1 && warehouseCount < numberOfClusters) ? 1 : 0,
    (isUnderAttack || ((enemyUnits.length / (aiFighters + 1)) * (enemyIsNear ? 1.5 : 1)) > 2) ? 1 : 0,
    (recentThreats.reduce((sum, t) => sum + (t.severity || 1), 0)) / 100,
    (gameState.buildings.filter(b => b.owner === "player" && !gameState.units.some(u => u.owner === "player" && Math.hypot(u.x - b.x, u.y - b.y) < 250)).length) / 10,
    Math.min((militaryCount || 0) / (pendingRewardCheck?.unitCount || 1), 3),
    canAfford(WAREHOUSE_COST, "ai") ? 1 : 0, canAfford(BARRACKS_COST, "ai") ? 1 : 0, canAfford(BEACON_COST, "ai") ? 1 : 0,
    canAfford(FIGHTER_COST, "ai") ? 1 : 0, canAfford(ELITE_COST, "ai") ? 1 : 0,
    ((hasWarehouse?1:0) + (hasWorkshop?1:0) + (hasBarracks?1:0) + (hasTurrets?1:0) + (hasBeacon?1:0)) / 5
  ];

  while (inputArray.length < 82) inputArray.push(0);
  if (inputArray.length > 82) inputArray.length = 82;

  for (let i = 0; i < inputArray.length; i++) {
    if (!isFinite(inputArray[i]) || isNaN(inputArray[i])) inputArray[i] = 0;
  }

  const normalizedInput = normalizeInputs(inputArray);
  lastInputArray = normalizedInput.slice();

  const rawLogits = tf.tidy(() => {
    const tensor = tf.tensor2d([normalizedInput]);
    return neuralModel.predict(tensor).dataSync();
  });

  const validMask = getValidActionMask();
  const chosenIndex = sampleActionWithTemperature(rawLogits, validMask, 1.2);
  const chosen = actions[chosenIndex];

  if (!chosen || !actions.includes(chosen)) {
    console.warn("[NeuralAI] ❌ Ошибка выбора действия. Fallback на idle.");
    return;
  }
  lastNeuralAction = chosen;
  if (actionUsageStats[chosen] !== undefined) actionUsageStats[chosen]++;

  if (lastActionRepeatType === chosen) lastActionRepeatCount++;
  else { lastActionRepeatType = chosen; lastActionRepeatCount = 1; }

  const prevState = {
    gold: gameState.aiResources.gold || 0,
    silicon: gameState.aiResources.silicon || 0,
    plasma: gameState.aiResources.plasma || 0,
    enemyCount: gameState.units.filter(u => u.owner === "player").length,
    aiUnitCount: gameState.units.filter(u => u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type)).length,
    aiBaseHealth: aiBase ? aiBase.health : 0
  };

  pendingRewardCheck.push({
    time: performance.now(),
    action: chosen,
    actionIndex: chosenIndex,
    input: lastInputArray,
    prevState: prevState
  });

  if (pendingRewardCheck.length > 10) {
    pendingRewardCheck.shift();
  }

  logNeuralPreferences(inputArray, rawLogits);

  // 🔥 ПРАВИЛЬНАЯ ЦЕПОЧКА IF / ELSE IF
  if (chosen === "build") {
    lastNeuralAction = "build";
    lastInputArray = inputArray.slice();
    const buildings = gameState.buildings.filter(b => b.owner === "ai");
    const hasW = buildings.some(b => b.type === "warehouse");
    const hasR = buildings.some(b => b.type === "repairWorkshop");
    const hasB = buildings.some(b => b.type === "barracks");
    const hasT = buildings.some(b => b.type === "turret");
    const hasBea = buildings.some(b => b.type === "beacon");
    const hasB2 = buildings.some(b => b.type === "base2");
    const hasBarr2 = buildings.some(b => b.type === "barracks2");
    const hasT2 = buildings.some(b => b.type === "turret2");
    const hasB3 = buildings.some(b => b.type === "base3");
    const hasBarr3 = buildings.some(b => b.type === "barracks3");
    const hasT3 = buildings.some(b => b.type === "turret3");

    let buildQueued = false;

    if (!hasW && canAfford(buildingCosts.warehouse, "ai")) { aiBuildQueue.push({ type: "warehouse", x: 0, y: 0, cost: buildingCosts.warehouse.gold }); buildQueued = true; }
    else if (hasW && !hasR && canAfford(buildingCosts.repairWorkshop, "ai")) { aiBuildQueue.push({ type: "repairWorkshop", x: 0, y: 0, cost: buildingCosts.repairWorkshop.gold }); buildQueued = true; }
    else if (hasR && !hasB && canAfford(buildingCosts.barracks, "ai")) { aiBuildQueue.push({ type: "barracks", x: 0, y: 0, cost: buildingCosts.barracks.gold }); buildQueued = true; }
    else if (hasB && !hasT && canAfford(buildingCosts.turret, "ai")) { aiBuildQueue.push({ type: "turret", x: 0, y: 0, cost: buildingCosts.turret.gold }); buildQueued = true; }
    else if (hasT && !hasBea && canAfford(buildingCosts.beacon, "ai")) { aiBuildQueue.push({ type: "beacon", x: 0, y: 0, cost: buildingCosts.beacon.gold }); buildQueued = true; }
    else if (hasBea && !hasB2 && canAfford(buildingCosts.base2, "ai")) { aiBuildQueue.push({ type: "base2", x: 0, y: 0, cost: buildingCosts.base2.gold }); buildQueued = true; }
    else if (hasB2 && !hasBarr2 && canAfford(buildingCosts.barracks2, "ai")) { aiBuildQueue.push({ type: "barracks2", x: 0, y: 0, cost: buildingCosts.barracks2.gold }); buildQueued = true; }
    else if (hasBarr2 && !hasT2 && canAfford(buildingCosts.turret2, "ai")) { aiBuildQueue.push({ type: "turret2", x: 0, y: 0, cost: buildingCosts.turret2.gold }); buildQueued = true; }
    else if (hasT2 && !hasB3 && canAfford(buildingCosts.base3, "ai")) { aiBuildQueue.push({ type: "base3", x: 0, y: 0, cost: buildingCosts.base3.gold }); buildQueued = true; }
    else if (hasB3 && !hasBarr3 && canAfford(buildingCosts.barracks3, "ai")) { aiBuildQueue.push({ type: "barracks3", x: 0, y: 0, cost: buildingCosts.barracks3.gold }); buildQueued = true; }
    else if (hasBarr3 && !hasT3 && canAfford(buildingCosts.turret3, "ai")) { aiBuildQueue.push({ type: "turret3", x: 0, y: 0, cost: buildingCosts.turret3.gold }); buildQueued = true; }

    if (!buildQueued) {
      const beacons = gameState.buildings.filter(b => b.owner === "ai" && b.type === "beacon");
      for (const beacon of beacons) {
        const near = (type) => gameState.buildings.some(b => b.owner === "ai" && b.type === type && distance(b, beacon) < 300);
        const alreadyInQueue = (type) => aiBuildQueue.some(job => job.type === type && job.near === beacon);
        if (!near("warehouse") && !alreadyInQueue("warehouse") && canAfford(buildingCosts.warehouse, "ai")) { aiBuildQueue.push({ type: "warehouse", near: beacon, cost: buildingCosts.warehouse.gold }); buildQueued = true; break; }
        if (near("warehouse") && !near("repairWorkshop") && !alreadyInQueue("repairWorkshop") && canAfford(buildingCosts.repairWorkshop, "ai")) { aiBuildQueue.push({ type: "repairWorkshop", near: beacon, cost: buildingCosts.repairWorkshop.gold }); buildQueued = true; break; }
        if (near("warehouse") && near("repairWorkshop") && !near("turret") && !alreadyInQueue("turret") && canAfford(buildingCosts.turret, "ai")) { aiBuildQueue.push({ type: "turret", near: beacon, cost: buildingCosts.turret.gold }); buildQueued = true; break; }
        if (near("turret") && !near("turret2") && !alreadyInQueue("turret2") && canAfford(buildingCosts.turret2, "ai")) { aiBuildQueue.push({ type: "turret2", near: beacon, cost: buildingCosts.turret2.gold }); buildQueued = true; break; }
        if (near("turret2") && !near("turret3") && !alreadyInQueue("turret3") && canAfford(buildingCosts.turret3, "ai")) { aiBuildQueue.push({ type: "turret3", near: beacon, cost: buildingCosts.turret3.gold }); buildQueued = true; break; }
      }
    }

    if (!buildQueued) {
      console.warn("[NeuralAI] ❌ BUILD: все здания уже построены или недостаточно ресурсов");
      penalizeBadDecision();
      return;
    }
    console.log("[NeuralAI] 🏗 Действие 'build' успешно добавлено в очередь");
  }
  else if (chosen === "expand") { lastNeuralAction = "expand"; lastInputArray = inputArray.slice(); handleExpandAction(); return; }
  else if (chosen === "hireFighter") { lastNeuralAction = "hireFighter"; lastInputArray = inputArray.slice(); hireUnitByType("fighter", 200); }
  else if (chosen === "hireAssault") { lastNeuralAction = "hireAssault"; lastInputArray = inputArray.slice(); hireUnitByType("assault", 250); }
  else if (chosen === "hireElite") { lastNeuralAction = "hireElite"; lastInputArray = inputArray.slice(); hireUnitByType("elite", 350); }
  else if (chosen === "counterAttack" && recentThreats.length > 0) {
    const group = getFreeReserveUnits().slice(0, 10);
    group.forEach(unit => { unit.commandQueue = [{ type: "move", x: recentThreats[0].x, y: recentThreats[0].y }, { type: "attack", target: null }]; });
  }
  else if (chosen === "mobilizeZone" && recentThreats.length > 0) {
    mobilizeDefendersAround({ x: recentThreats[0].x, y: recentThreats[0].y }, 250);
    if (gameState.buildings.filter(b => b.owner === "ai" && b.type.startsWith("turret") && Math.hypot(b.x - recentThreats[0].x, b.y - recentThreats[0].y) < 200).length === 0 && canAfford(TURRET_COST, "ai")) {
      scheduleAIBuilding("turret", recentThreats[0].x + 40, recentThreats[0].y + 40, 500);
    }
  }
  else if (chosen === "opportunisticStrike") {
    const vulnerable = gameState.buildings.filter(b => b.owner === "player" && b.type !== "turret" && b.type !== "base" && !gameState.units.some(u => u.owner === "player" && Math.hypot(u.x - b.x, u.y - b.y) < 250));
    if (vulnerable.length > 0) {
      const group = getFreeReserveUnits().slice(0, 6);
      group.forEach(unit => { unit.commandQueue = [{ type: "move", x: vulnerable[0].x, y: vulnerable[0].y }, { type: "attack", target: null }]; });
    }
  }
  else if (chosen === "pursueRetreating") {
    const targets = gameState.units.filter(u => u.owner === "player" && u.velocity && Math.hypot(u.velocity.x || 0, u.velocity.y || 0) > 1);
    const group = getFreeReserveUnits().slice(0, 6);
    group.forEach(unit => { const nearest = findNearest(unit, targets); if (nearest) unit.commandQueue = [{ type: "move", x: nearest.x, y: nearest.y }, { type: "attack", target: nearest }]; });
  }
  else if (chosen === "isolateIntruders") {
    const lone = gameState.units.filter(u => u.owner === "player" && gameState.units.filter(o => o.owner === "player" && Math.hypot(o.x - u.x, o.y - u.y) < 200).length <= 2);
    if (lone.length > 0) {
      const group = getFreeReserveUnits().slice(0, 5);
      group.forEach(unit => { const target = findNearest(unit, lone); unit.commandQueue = [{ type: "move", x: target.x, y: target.y }, { type: "attack", target: target }]; });
    }
  }
  else if (chosen === "reinforceFlank" && recentThreats.length > 0) {
    const units = getFreeReserveUnits().slice(0, 4);
    units.forEach(u => { u.commandQueue = [{ type: "move", x: recentThreats[0].x, y: recentThreats[0].y }]; });
    if (canAfford(buildingCosts.turret, "ai")) scheduleAIBuilding("turret", recentThreats[0].x + 50, recentThreats[0].y + 30, 1000);
  }
  else if (chosen === "avoidZone") {
    console.log("[NeuralAI] ⚠️ avoidZone: избегаем зон", recentThreats.slice(-3).map(t => ({ x: t.x, y: t.y })));
  }
  else if (chosen === "preemptiveStrike") {
    const clustered = findEnemyClusters(6);
    if (clustered.length > 0) {
      const group = getFreeReserveUnits().slice(0, 8);
      group.forEach(unit => { unit.commandQueue = [{ type: "move", x: clustered[0].x, y: clustered[0].y }, { type: "attack", target: null }]; });
    }
  }
  else if (chosen === "scoutThreatZone" && recentThreats.length > 0) {
    const scout = getFreeReserveUnits().find(u => u.type === "fighter");
    if (scout) scout.commandQueue = [{ type: "move", x: recentThreats[0].x, y: recentThreats[0].y }];
  }
  else if (chosen === "longFlank") {
    const enemyBase = gameState.buildings.find(b => b.owner === "player" && b.type === "base");
    if (enemyBase) {
      const quadrants = [
        { x: enemyBase.x - 800, y: enemyBase.y - 800 },
        { x: enemyBase.x + 800, y: enemyBase.y - 800 },
        { x: enemyBase.x - 800, y: enemyBase.y + 800 },
        { x: enemyBase.x + 800, y: enemyBase.y + 800 }
      ];
      const bestQuadrant = quadrants.reduce((best, q) => {
        const threats = recentThreats.filter(t => Math.hypot(t.x - q.x, t.y - q.y) < 200).length;
        return threats < best.threats ? { ...q, threats } : best;
      }, { threats: Infinity });
      
      const group = getFreeReserveUnits().slice(0, 8);
      group.forEach(unit => {
        unit.commandQueue = [{ type: "move", x: bestQuadrant.x, y: bestQuadrant.y }, { type: "attack", target: null }];
      });
      console.log(`[Tactics] 🎯 Длинный фланг через квадрант (${bestQuadrant.x.toFixed(0)}, ${bestQuadrant.y.toFixed(0)})`);
    }
  }
  else if (chosen === "deepStrike") {
    const enemyBase = gameState.buildings.find(b => b.owner === "player" && b.type === "base");
    if (enemyBase) {
      const angle = Math.atan2(enemyBase.y - aiBase.y, enemyBase.x - aiBase.x);
      const deepX = enemyBase.x + Math.cos(angle) * 400;
      const deepY = enemyBase.y + Math.sin(angle) * 400;
      
      const group = getFreeReserveUnits().filter(u => u.type === "elite" || u.type === "assault").slice(0, 4);
      group.forEach(unit => {
        unit.commandQueue = [{ type: "move", x: deepX, y: deepY }, { type: "attack", target: null }];
      });
      console.log(`[Tactics] ⚡ Глубокий рейд в тыл (${deepX.toFixed(0)}, ${deepY.toFixed(0)})`);
    }
  }
  else {
    assignUnitTargetsIndividually(chosen);
  }

  if (!lastNeuralAction || !actions.includes(lastNeuralAction)) console.warn("[NeuralAI] ️ Действие не было сохранено корректно:", chosen);

  lastGoldDelta = goldDelta; lastSiliconDelta = siliconDelta; lastPlasmaDelta = plasmaDelta;
  lastWorkerCount = workerCount; lastIdleWarehouseCount = idleWarehouseCountLocal; lastWarehouseCount = warehouseCount;
  nextDecisionDelay = { attack: 3000, defend: 4500, build: 5000, idle: 2000, flank: 4500, ambush: 3000, retreat: 4500, protect: 5000, strikeClusters: 5000, attackWeakSpot: 4500, fallback: 4000, scout: 4000, regroup: 5500, harass: 4000, expand: 5000 }[chosen] || 2000;
  lastInput = inputArray; lastActionIndex = chosenIndex;

  if (lastActionRepeatCount >= 5 && !["scout", "idle"].includes(chosen)) {
    console.warn(`[NeuralAI] ♻️ Залипание на действии: ${chosen} (${lastActionRepeatCount} раз). Штраф.`);
    penalizeBadDecision();
    lastActionRepeatCount = 0;
  }

  const actionVector = new Array(actions.length).fill(0);
  actionVector[actions.indexOf(chosen)] = 1;
  trainingData.inputs.push(inputArray);
  trainingData.outputs.push(actionVector);
  idlePenaltyCount = 0;

  const unitTypes = aiUnits.map(u => u.type);
  if (unitTypes.every(t => t === "fighter") && aiUnits.length >= 5 && !hasBase2 && !hasBarracks2) {
    spamPenaltyCount = (spamPenaltyCount || 0) + 1;
    if (spamPenaltyCount >= 3) { penalizeBadDecision(); spamPenaltyCount = 0; }
  } else { spamPenaltyCount = Math.max(0, spamPenaltyCount - 1); }

  const underAttack = gameState.buildings.some(b =>
    b.owner === "ai" &&
    b.health < b.maxHealth * 0.85 &&
    b.type.startsWith("base")
  );

  const aiCombatUnits = gameState.units.filter(u =>
    u.owner === "ai" &&
    ["fighter", "assault", "elite"].includes(u.type)
  );

  if (underAttack && aiCombatUnits.length > 0) {
    aiCombatUnits.forEach(unit => {
      const base = findNearestAIBuilding(unit.x, unit.y);
      if (base) {
        unit.commandQueue = [{ type: "move", x: base.x, y: base.y }];
        unit.defending = true;
        processCommandQueue(unit);
      }
    });
    return;
  }

  const nowMilitary = gameState.units.filter(u => u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type)).length;
  const nowBuilds = gameState.buildings.filter(b => b.owner === "ai").length;
  const res = gameState.aiResources || {};

  pendingRewardCheck = pendingRewardCheck.filter(check => {
    const evalDelay = (check.action === "build" || check.action === "expand" || check.action.includes("hire")) ? 15000 : 4000;

    if (now - check.time < evalDelay) {
      return true;
    }

    const currentState = {
      gold: gameState.aiResources.gold || 0,
      silicon: gameState.aiResources.silicon || 0,
      plasma: gameState.aiResources.plasma || 0,
      enemyCount: gameState.units.filter(u => u.owner === "player").length,
      aiUnitCount: gameState.units.filter(u => u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type)).length,
      aiBaseHealth: aiBase ? aiBase.health : 0
    };

    const reward = calculateReward(check.action, check.prevState, currentState);
    storeExperience(check.input, check.actionIndex, reward, currentState);

    if (reward > 0) {
      console.log(`[NeuralAI] ✅ Награда +${reward.toFixed(2)} за '${check.action}' (оценка через ${evalDelay/1000}с)`);
    } else if (reward < 0) {
      console.warn(`[NeuralAI] ⚠️ Штраф ${reward.toFixed(2)} за '${check.action}' (оценка через ${evalDelay/1000}с)`);
    }

    return false;
  });

  if (lastNeuralAction && lastInputArray) {
    const lowGrowth = goldDelta < 0.1 && siliconDelta < 0.1 && plasmaDelta < 0.1;
    const hasResources = aiRes.gold > 150 || aiRes.silicon > 150;
    const idleTooMany = lastWarehouseCount > 0 && lastIdleWarehouseCount >= Math.floor(lastWarehouseCount / 2);
    const noWorkers = lastWorkerCount === 0;

    const isActivelyBuilding = aiBuildQueue.length > 0 || (lastNeuralAction === "build");
    const checkStagnationRelevant = ["build", "expand", "hireFighter", "hireElite", "hireAssault"];

    if (!isActivelyBuilding && checkStagnationRelevant.includes(lastNeuralAction)) {
      let reasons = [];
      if (lowGrowth && hasResources) reasons.push("📉 Низкий прирост ресурсов");
      if (idleTooMany) reasons.push("📦 >50% складов не работают");
      if (noWorkers) reasons.push("🤖 Нет рабочих");

      if (reasons.length >= 2) {
        console.warn(`[NeuralAI] ⚠️ Обнаружена стагнация (${reasons.join(', ')}) — штрафуем!`);
        penalizeBadDecision();
      }

      if ((idleTooMany || noWorkers) && ["hireFighter", "hireElite", "hireAssault"].includes(lastNeuralAction)) {
        console.warn("[NeuralAI] ❌ В условиях стагнации ИИ нанял боевого юнита — штраф!");
        penalizeBadDecision();
      }
    }
  }

  const resourceGrew = goldDelta > lastGoldDelta || siliconDelta > lastSiliconDelta || plasmaDelta > lastPlasmaDelta;
  const newMilitaryCount = gameState.units.filter(u => u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type)).length;
  const militaryIncreased = newMilitaryCount > militaryCount || (pendingRewardCheck ? Math.min(newMilitaryCount / pendingRewardCheck.unitCount, 3) : 0) > 1.05;
  const builtSomething = buildsRecent > 0;
  const isCombatAction = ["attack", "defend", "ambush", "protect", "strikeClusters", "attackWeakSpot", "flank", "retreat", "counterAttack", "mobilizeZone", "opportunisticStrike", "pursueRetreating", "isolateIntruders", "reinforceFlank", "preemptiveStrike"].includes(lastNeuralAction);
  const aiAttacking = gameState.units.some(u => u.owner === "ai" && Array.isArray(u.commandQueue) && u.commandQueue.some(c => c.type === "attack"));
  const combatProgress = isCombatAction && (aiAttacking || currentEnemyCount < previousEnemyCount);

  const economicActions = ["build", "expand", "hireFighter", "hireAssault", "hireElite", "idle"];
  const combatActionsList = ["attack", "defend", "ambush", "protect", "strikeClusters", "attackWeakSpot", "flank", "retreat", "counterAttack", "mobilizeZone", "opportunisticStrike", "pursueRetreating", "isolateIntruders", "reinforceFlank", "preemptiveStrike", "scoutThreatZone"];

  const isEconomicAction = economicActions.includes(lastNeuralAction);

  const aiArmy = gameState.units.filter(u => u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type));
  const hasArmy = aiArmy.length >= 3;

  if (isEconomicAction && (resourceGrew || militaryIncreased || builtSomething) && lastNeuralAction && actions.includes(lastNeuralAction) && !combatEvaluated && lastRewardedAction !== lastNeuralAction) {
    console.log("[NeuralAI] 🎉 Экономический прогресс — поощрение");
    rewardGoodDecision();
    lastRewardedAction = lastNeuralAction;
  }

  if (isCombatAction && !hasArmy && lastNeuralAction && actions.includes(lastNeuralAction) && !combatEvaluated && lastRewardedAction !== lastNeuralAction) {
    console.warn(`[NeuralAI] ❌ Боевое действие '${lastNeuralAction}' без армии (армия: ${aiArmy.length}) — штраф!`);
    penalizeBadDecision();
    lastRewardedAction = lastNeuralAction;
  }

  const aiWorkers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker");
  if (aiWorkers.length === 0 && canAfford(unitCosts.worker, "ai")) {
    const warehouse = gameState.buildings.find(b => b.owner === "ai" && b.type === "warehouse");
    if (warehouse && warehouse.active) {
      if (!warehouse.productionQueue) warehouse.productionQueue = [];
      warehouse.productionQueue.push({ unitType: "worker", owner: "ai" });
    }
  }

  analyzeCombatOutcome();
  previousEnemyCount = currentEnemyCount;

  const perfEnd = performance.now();
  const cycleTime = perfEnd - perfStart;

  aiPerfStats.count++;
  aiPerfStats.totalTime += cycleTime;
  if (cycleTime > aiPerfStats.maxTime) {
    aiPerfStats.maxTime = cycleTime;
  }

  if (aiPerfStats.count % 10 === 0) {
    const avg = (aiPerfStats.totalTime / aiPerfStats.count).toFixed(2);
    const max = aiPerfStats.maxTime.toFixed(2);
    console.log(`[⚡ Perf AI] Циклов: ${aiPerfStats.count} | Среднее: ${avg}мс | Макс: ${max}мс`);
  }
  trainFromReplayBatch();
}

function getFreeReserveUnits() {
  return gameState.units.filter(u =>
    u.owner === "ai" &&
    ["fighter", "assault", "elite"].includes(u.type) &&
    (!u.commandQueue || u.commandQueue.length === 0)
  );
}

function scheduleAIBuilding(type, x, y, delay = 0) {
  setTimeout(() => {
    if (canAfford(buildingCosts[type], "ai")) {
      aiBuildQueue.push({ type: type, x: x, y: y, cost: buildingCosts[type] });
      console.log(`[NeuralAI] 🏗 Отложено строительство: ${type}`);
    }
  }, delay);
}

function aiEnqueueMilitaryUnit(unitType, building) {
  if (!building.active) return false;

  if (unitType === "fighter" && building.type !== "barracks") return false;
  if (unitType === "assault" && building.type !== "barracks2") return false;
  if (unitType === "elite" && building.type !== "barracks3") return false;

  let productionTime;
  switch(unitType) {
    case "fighter": productionTime = 6000; break;
    case "assault": productionTime = 12000; break;
    case "elite": productionTime = 25000; break;
    default: return false;
  }

  if (!building.productionQueue) {
    building.productionQueue = [];
  }

  if (building.productionQueue.length >= building.productionLimit) return false;

  const lastOrder = building.productionQueue[building.productionQueue.length - 1];
  let timeStart = performance.now();
  if (lastOrder) {
    timeStart = lastOrder.timeStart + lastOrder.productionTime;
  }

  const order = {
    unitType: unitType,
    timeStart: timeStart,
    productionTime: productionTime
  };

  building.productionQueue.push(order);
  return true;
}

function findNearest(from, targets) {
  let best = null, minDist = Infinity;
  for (const t of targets) {
    const dist = Math.hypot(from.x - t.x, from.y - t.y);
    if (dist < minDist) { best = t; minDist = dist; }
  }
  return best;
}

function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function findEnemyClusters(minCount = 5, radius = 150) {
  const clusters = [];
  const enemies = gameState.units.filter(u => u.owner === "player");
  for (const u of enemies) {
    const close = enemies.filter(other => distance(u, other) < radius);
    if (close.length >= minCount) clusters.push({ x: u.x, y: u.y, count: close.length });
  }
  clusters.sort((a, b) => b.count - a.count);
  return clusters;
}

function cleanUpRecentThreats() {
  const now = Date.now();
  recentThreats = recentThreats.filter(t => now - t.timestamp < 30000);
}
cleanUpRecentThreats();
function mobilizeDefendersAround(pos, radius = 250) {
  const defenders = getFreeReserveUnits();
  defenders.forEach(unit => {
    if (Math.hypot(unit.x - pos.x, unit.y - pos.y) < radius * 2) {
      unit.commandQueue = [{ type: "move", x: pos.x, y: pos.y }, { type: "defend", position: { x: pos.x, y: pos.y } }];
    }
  });
}

function getUnscoutedPosition() {
  for (let i = 0; i < 10; i++) {
    const x = Math.random() * worldWidth, y = Math.random() * worldHeight;
    if (typeof isInFogOfWar === "function" && isInFogOfWar(x, y)) return { x, y };
  }
  return null;
}

function resetNeuralAI() {
  tf.io.removeModel(LOCAL_MODEL_PATH).then(() => {
    console.log("[NeuralAI] Модель удалена из памяти браузера");
    alert("Модель сброшена. Перезагрузите страницу.");
    location.reload();
  }).catch(err => console.error("[NeuralAI] Ошибка при удалении модели:", err));
}

function isInBuildableRadius(x, y, owner = "ai") {
  return gameState.buildings.some(b => b.owner === owner && ["base", "base2", "base3", "beacon"].includes(b.type) && Math.hypot(b.x - x, b.y - y) <= 300);
}

async function saveModelToServer(model) {
  try { await model.save(LOCAL_MODEL_PATH); }
  catch (err) { console.error("[Neural] ❌ Ошибка сохранения модели:", err); }
}

function distanceToNearestBuilding(x, y, ownerFilter, typeFilter) {
  let minDist = Infinity;
  for (const b of gameState.buildings) {
    if (ownerFilter && b.owner !== ownerFilter) continue;
    if (typeFilter && !b.type.startsWith(typeFilter)) continue;
    const dist = Math.hypot(b.x - x, b.y - y);
    if (dist < minDist) minDist = dist;
  }
  return minDist;
}

function hasActiveBarracks(type) {
  return gameState.buildings.some(b => b.owner === "ai" && b.type === type && b.active);
}

function evaluateActionScore(action) {
  const state = gameState;
  const aiUnits = state.units.filter(u => u.owner === "ai");
  const enemyUnits = state.units.filter(u => u.owner === "player");
  const militaryCount = aiUnits.filter(u => ["fighter", "assault", "elite"].includes(u.type)).length;
  const hasResources = state.aiResources.gold + state.aiResources.silicon > 150;
  const underAttack = state.units.some(u => u.owner === "player" && distanceToNearestBuilding(u.x, u.y, "ai") < 300);

  if (["attack", "attackWeakSpot", "flank", "ambush", "harass", "counterAttack", "strikeClusters"].includes(action) && militaryCount < 1) return -1.5;
  if (action === "hireFighter" && !hasActiveBarracks("barracks")) return -2;
  if (action === "hireAssault" && !hasActiveBarracks("barracks2")) return -2;
  if (action === "hireElite" && !hasActiveBarracks("barracks3")) return -2;
  if (["scoutThreatZone", "counterAttack", "mobilizeZone", "reinforceFlank"].includes(action) && recentThreats.length === 0) return -1.2;

  cleanUpRecentThreats();
  switch (action) {
    case "attack": case "attackWeakSpot": case "harass": case "flank":
      return (enemyUnits.length > 0 && militaryCount >= 3 ? 1 : -0.5) + (0.15 * recentCombatSuccesses - 0.2 * recentCombatFailures);
    case "build": {
      const hasResources = state.aiResources.gold + state.aiResources.silicon > 150;
      const hasWorkers = state.units.some(u => u.owner === "ai" && u.type === "worker");
      const hasIdleWarehouses = state.buildings.some(b => b.owner === "ai" && b.type === "warehouse" && (!b.workers || b.workers === 0));

      if (hasResources && (!hasWorkers || hasIdleWarehouses)) {
        return -0.8;
      }

      return (hasResources ? 1.0 : -0.5) + (0.1 * recentCombatFailures);
    }
    case "retreat": case "fallback": return (underAttack ? 1 : -0.7) + (0.1 * recentCombatFailures);
    case "idle": return -1;
    case "strikeClusters": case "ambush": case "protect":
      return (militaryCount >= 5 ? 0.8 : -0.5) + (0.1 * recentCombatSuccesses - 0.1 * recentCombatFailures);
    case "defend": return underAttack ? 0.8 : 0.2;
    case "regroup": return 0.3 + 0.1 * recentCombatFailures;
    case "scout": return 0.3;
    case "expand": {
      const beacons = state.buildings.filter(b => b.owner === "ai" && b.type === "beacon");
      const warehouses = state.buildings.filter(b => b.owner === "ai" && b.type === "warehouse");
      if (beacons.length >= 10) return -2.0;
      if (beacons.filter(beacon => !warehouses.some(w => distance(beacon, w) < 300)).length >= 3) return -1.5;
      if (warehouses.length < Math.floor(beacons.length / 2)) return -0.5;
      if (militaryCount < 3 && beacons.length >= 2) return -1.0;
      return 0.5;
    }
    case "counterAttack": return (recentThreats.length > 0 && militaryCount >= 4 ? 1.0 : -0.5) + (0.15 * recentCombatSuccesses - 0.15 * recentCombatFailures);
    case "mobilizeZone": return (recentThreats.length > 0 && militaryCount >= 4 ? 0.8 : -0.3) + (0.1 * recentCombatSuccesses - 0.1 * recentCombatFailures);
    case "opportunisticStrike": {
      const exposed = state.buildings.filter(b => b.owner === "player" && b.type !== "turret" && !state.units.some(u => u.owner === "player" && Math.hypot(u.x - b.x, u.y - b.y) < 250)).length;
      return (exposed > 0 && militaryCount >= 3 ? 0.9 : -0.5) + (0.1 * recentCombatSuccesses - 0.15 * recentCombatFailures);
    }
    case "pursueRetreating": {
      const retreating = state.units.filter(u => u.owner === "player" && u.velocity && Math.hypot(u.velocity.x || 0, u.velocity.y || 0) > 1).length;
      return retreating > 0 && militaryCount >= 3 ? 0.7 : -0.5;
    }
    case "isolateIntruders": {
      const lone = state.units.filter(u => u.owner === "player" && state.units.filter(o => o.owner === "player" && Math.hypot(o.x - u.x, o.y - u.y) < 200).length <= 2).length;
      return lone > 0 && militaryCount >= 2 ? 0.6 : -0.5;
    }
    case "reinforceFlank": return (recentThreats.length > 0 && militaryCount >= 3 ? 0.7 : -0.5) + (0.1 * recentCombatSuccesses - 0.1 * recentCombatFailures);
    case "avoidZone": return recentThreats.length >= 3 ? 0.4 : -1;
    case "preemptiveStrike": {
      const idle = state.units.filter(u => u.owner === "ai" && (!u.commandQueue || u.commandQueue.length === 0)).length;
      return (enemyUnits.length >= 6 && idle >= 4 ? 0.9 : -0.5) + (0.1 * recentCombatSuccesses - 0.15 * recentCombatFailures);
    }
    case "scoutThreatZone": return recentThreats.length > 0 ? 0.6 : -0.7;
    default: return 0;
  }
}

const penaltyHistory = {};
const rewardHistory = {};

function penalizeBadDecision() {
  // 🔥 ИЗМЕНЕНО: 77 на 82, так как мы добавили 5 новых признаков
  if (!Array.isArray(lastInputArray) || lastInputArray.length !== 82 || !actions.includes(lastNeuralAction)) return;

  const action = lastNeuralAction;
  const score = evaluateActionScore(action);

  if (score > 1.0) {
    console.log(`[NeuralAI] 🛡️ ЗАЩИТА: Пропуск штрафа для '${action}'. Эвристическая оценка слишком высока (${score.toFixed(2)}).`);
    return;
  }

  const index = actions.indexOf(action);
  penaltyHistory[action] = (penaltyHistory[action] || 0) + 1;
  const penaltyLevel = Math.min(1.0, 0.2 + penaltyHistory[action] * 0.1);

  const output = actions.map((_, i) => i === index ? Math.max(0.05, 1.0 - penaltyLevel) : 0.1);

  console.warn(`[NeuralAI] 🚨 Штраф: ${action} | Уровень: ${penaltyLevel.toFixed(2)} | Оценка: ${score.toFixed(2)}`);
  safePushTraining({ inputs: lastInputArray, targetOverride: output, action: lastNeuralAction, info: "[penalty]" });

  const altAction = findBestAlternative(action);
  if (altAction && actions.includes(altAction)) {
    safePushTraining({ inputs: lastInputArray, targetOverride: actions.map(a => (a === altAction ? 1.0 : 0.05)), action: altAction, info: "[auto-alt]" });
  }
  processTrainingQueue();
}

function calculateReward(action, prevState, currentState) {
  let reward = 0;

  const resourceGrowth = (currentState.gold + currentState.silicon + currentState.plasma) -
                         (prevState.gold + prevState.silicon + prevState.plasma);

  // 1. ЭКОНОМИКА И РАЗВИТИЕ
  if (action === "build" || action === "expand" || action === "hireFighter" || action === "hireAssault" || action === "hireElite") {
    
    if (action === "hireFighter" || action === "hireAssault" || action === "hireElite") {
      if (currentState.aiUnitCount <= prevState.aiUnitCount) {
        reward -= 0.3;
        console.log(`[RewardDebug] ❌ Штраф за нереализованный найм: ${action}`);
      } else {
        reward += 0.4;
        console.log(`[RewardDebug] ✅ Награда за успешный найм: ${action}`);
      }
    } 
    else if (action === "build" || action === "expand") {
      const isCriticalStagnation = (currentState.gold < 5 && currentState.silicon < 5 && currentState.aiUnitCount === 0);
      if (isCriticalStagnation) {
        reward -= 0.2;
      } else {
        reward += 0.4;
      }
    }
  }

  // 2. Боевая награда (Убийства vs Потери)
  const enemyLosses = prevState.enemyCount - currentState.enemyCount;
  const aiLosses = prevState.aiUnitCount - currentState.aiUnitCount;
  
  if (["attack", "defend", "counterAttack", "mobilizeZone", "opportunisticStrike"].includes(action)) {
    reward += (enemyLosses * 1.5) - (aiLosses * 1.0);
  }
	
  // 3. 🔥 ИСПРАВЛЕННАЯ награда за защиту (только если была реальная атака!)
  const baseHealthStable = currentState.aiBaseHealth >= prevState.aiBaseHealth;
  
  // Проверяем, была ли реальная угроза (враги рядом с базой)
  const wasUnderAttack = gameState.buildings.some(b => 
    b.owner === "ai" && 
    b.type.startsWith("base") &&
    gameState.units.some(u => 
      u.owner === "player" && 
      Math.hypot(u.x - b.x, u.y - b.y) < 300 // Враг в радиусе 300 от базы
    )
  );
  
  // Проверяем, есть ли у ИИ армия для защиты
  const hasArmy = currentState.aiUnitCount > 0;
  
  if (baseHealthStable && ["defend", "protect", "mobilizeZone"].includes(action)) {
    if (wasUnderAttack && hasArmy) {
      reward += 0.4; // ✅ Реальная защита: была атака, армия есть, база выстояла
      console.log(`[RewardDebug] ✅ Награда за реальную защиту: ${action}`);
    } else if (!wasUnderAttack) {
      reward -= 0.2; // ❌ Ложная защита: никакой угрозы не было
      console.log(`[RewardDebug] ⚠️ Штраф за ложную защиту (нет угрозы): ${action}`);
    } else if (!hasArmy) {
      reward -= 0.3; // ❌ Невозможная защита: нет армии
      console.log(`[RewardDebug] ⚠️ Штраф за защиту без армии: ${action}`);
    }
  }

  // 4. Штраф за бездействие при наличии ресурсов
  if (action === "idle" && (currentState.gold > 150 || currentState.silicon > 150)) {
    reward -= 0.5;
  }

  return Math.max(-1.0, Math.min(1.0, reward));
}

function rewardGoodDecision(isRealOutcome = false) {
  if (!Array.isArray(lastInputArray) || lastInputArray.length !== 82 || !actions.includes(lastNeuralAction)) return;
  const action = lastNeuralAction;
  const score = evaluateActionScore(action);
  const index = actions.indexOf(action);
  rewardHistory[action] = (rewardHistory[action] || 0) + 1;

  const boost = isRealOutcome ? 1.0 : Math.min(1.0, 0.6 + rewardHistory[action] * 0.05);
  const output = actions.map((_, i) => i === index ? boost : 0.05);

  console.log(`[NeuralAI] ✅ Поощряем: ${action} (x${rewardHistory[action]}) с оценкой ${score.toFixed(2)}`);
  safePushTraining({ inputs: lastInputArray, targetOverride: output, action: lastNeuralAction, info: isRealOutcome ? "[real_reward]" : "[heuristic_reward]" });
  confirmedStrategies.push({ inputs: lastInputArray.slice(), action: action });
  processTrainingQueue();
}

function handleExpandAction() {
  const aiRes = gameState.aiResources;
  const base = gameState.buildings.find(b => b.owner === "ai" && b.type.includes("base"));
  if (!aiRes || !base) { penalizeBadDecision(); return; }
  const existingBeacons = gameState.buildings.filter(b => b.owner === "ai" && b.type === "beacon");
  if (existingBeacons.length >= 5) { penalizeBadDecision(); return; }

  for (let i = 0; i < 10; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 800 + Math.random() * 300;
    const x = base.x + Math.cos(angle) * dist;
    const y = base.y + Math.sin(angle) * dist;
    const tooClose = gameState.buildings.some(b => b.owner === "ai" && Math.hypot(b.x - x, b.y - y) < 300 && ["beacon", "warehouse", "base"].includes(b.type));
    if (!tooClose && x > 100 && y > 100 && x < worldWidth - 100 && y < worldHeight - 100) {
      if (canAfford(BEACON_COST, "ai")) {
        aiBuildQueue.push({ type: "beacon", x, y, cost: BEACON_COST });
        console.log(`[NeuralAI] 📡 Расширение: beacon в ${x.toFixed(0)}, ${y.toFixed(0)}`);
        rewardGoodDecision();
      } else { penalizeBadDecision(); }
      return;
    }
  }
  penalizeBadDecision();
}

function logModelWeightsSummary() {
  neuralModel.getWeights().forEach(async (w, i) => {
    const d = await w.data();
    console.log(`Вес #${i} ➤ min=${Math.min(...d).toFixed(3)}, max=${Math.max(...d).toFixed(3)}, avg=${(d.reduce((a,b)=>a+b,0)/d.length).toFixed(3)}`);
  });
}

function softmax(logits) {
  const maxLogit = Math.max(...logits);
  const exps = logits.map(x => Math.exp(x - maxLogit));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
}

let lastLogTime = 0;

function logNeuralPreferences(inputArray, cachedLogits = null) {
  if (!cachedLogits || !Array.isArray(cachedLogits)) return;

  const now = performance.now();
  if (now - lastLogTime < 3000) return;
  lastLogTime = now;

  if (!neuralModel || !Array.isArray(inputArray) || inputArray.length !== 82) return;

  const raw = cachedLogits;

  const clipped = raw.map(v => Math.max(Math.min(v, 100), -100));
  const maxLogit = Math.max(...clipped);
  const exps = clipped.map(x => Math.exp(x - maxLogit));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map(e => e / sum);

  const indexed = actions.map((act, i) => ({ action: act, prob: probs[i] ?? 0, score: raw[i] ?? 0 })).sort((a, b) => b.prob - a.prob);

  console.groupCollapsed(`[🧠 Neural Top: ${lastNeuralAction || 'init'}]`);
  indexed.slice(0, 3).forEach(entry => {
    console.log(`${entry.action.padEnd(20)} | ${(entry.prob * 100).toFixed(1)}%`);
  });
  console.groupEnd();
}

function safePushTraining({ inputs, targetOverride, action, info = "" }) {
  if (!inputs || !Array.isArray(inputs) || inputs.length !== 82) return;
  if (inputs.some(v => !isFinite(v) || isNaN(v))) return;
  if (!action || typeof action !== "string" || !actions.includes(action)) return;
  if (!Array.isArray(targetOverride) || targetOverride.length !== actions.length || targetOverride.some(v => typeof v !== "number" || isNaN(v))) return;
  trainingQueue.push({ inputs, targetOverride, action, info });
}

async function reinforceConfirmedStrategies() {
  if (!neuralModel || confirmedStrategies.length === 0) return;
  const sample = confirmedStrategies.slice(-10);
  const xs = tf.tensor2d(sample.map(s => s.inputs));
  const ys = tf.tensor2d(sample.map(s => { const vec = new Array(actions.length).fill(0); vec[actions.indexOf(s.action)] = 1; return vec; }));
  try {
    await neuralModel.fit(xs, ys, { epochs: 1, batchSize: sample.length, shuffle: true });
    await saveModelToServer(neuralModel);
  } catch (e) { console.error("[NeuralAI] Ошибка при усилении стратегий:", e); }
  finally { xs.dispose(); ys.dispose(); }
}

function logActionUsageStats() {
  console.group("[ Neural Usage Stats]");
  const total = Object.values(actionUsageStats).reduce((a, b) => a + b, 0);
  actions.forEach(a => {
    const count = actionUsageStats[a];
    const pct = total > 0 ? (count / total * 100).toFixed(1) : "0.0";
    console.log(`${a.padEnd(15)} | ${"█".repeat(Math.round(pct / 5))} ${count} (${pct}%)`);
  });
  console.groupEnd();
}

function findBestAlternative(currentAction) {
  const currentScore = evaluateActionScore(currentAction);
  const candidates = actions.filter(a => a !== currentAction).map(a => ({ action: a, score: evaluateActionScore(a) })).filter(entry => entry.score > currentScore && entry.score > 0).sort((a, b) => b.score - a.score);
  return candidates.length > 0 ? candidates[0].action : null;
}

function analyzeCombatOutcome() {
  if (!lastNeuralAction || !actions.includes(lastNeuralAction)) return;
  const combatActions = ["attack", "defend", "ambush", "protect", "strikeClusters", "attackWeakSpot", "flank", "retreat", "counterAttack", "mobilizeZone", "opportunisticStrike", "pursueRetreating", "isolateIntruders", "reinforceFlank", "preemptiveStrike"];
  if (!combatActions.includes(lastNeuralAction)) return;

  const aiArmy = gameState.units.filter(u => u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type));
  if (aiArmy.length === 0) { penalizeBadDecision(); recentCombatFailures++; recentCombatSuccesses = Math.max(0, recentCombatSuccesses - 1); return; }
  if (aiArmy.length < 3) return;

  const hasAttackOrders = aiArmy.some(u => Array.isArray(u.commandQueue) && u.commandQueue.some(c => c.type === "attack" || c.type === "move"));
  const currentEnemyCount = gameState.units.filter(u => u.owner === "player").length;
  const aiLosses = (pendingRewardCheck?.unitCount || aiArmy.length) - aiArmy.length;
  const enemyLosses = previousEnemyCount - currentEnemyCount;
  const destroyedEnemyBuildings = (gameState.recentLosses || []).filter(b => b.owner === "player" && performance.now() - b.time < 5000).length || 0;
  const lostAiBuildings = (gameState.recentLosses || []).filter(b => b.owner === "ai" && performance.now() - b.time < 5000) || [];
  const lostImportant = lostAiBuildings.some(b => ["base", "barracks", "warehouse", "beacon"].includes(b.type));

  if (!hasAttackOrders) {
    penalizeBadDecision(); recentCombatFailures++; recentCombatSuccesses = Math.max(0, recentCombatSuccesses - 1);
  } else {
    rewardGoodDecision(); recentCombatSuccesses++; recentCombatFailures = Math.max(0, recentCombatFailures - 1);
  }

  if (aiArmy.length < (pendingRewardCheck?.unitCount || aiArmy.length)) {
    if (enemyLosses > aiLosses || destroyedEnemyBuildings > 0) { rewardGoodDecision(); recentCombatSuccesses++; recentCombatFailures = Math.max(0, recentCombatFailures - 1); }
    else { penalizeBadDecision(); recentCombatFailures++; recentCombatSuccesses = Math.max(0, recentCombatSuccesses - 1); }
  }

  if (lostAiBuildings.length > 0) {
    penalizeBadDecision(); recentCombatFailures++; recentCombatSuccesses = Math.max(0, recentCombatSuccesses - 1);
    if (lostImportant) { penalizeBadDecision(); recentCombatFailures++; recentCombatSuccesses = Math.max(0, recentCombatSuccesses - 1); }
  }

  combatEvaluated = true;
  lastRewardedAction = lastNeuralAction;
  if (recentCombatSuccesses >= 3) console.log("[NeuralAI] 😎 Характер: агрессивный");
  else if (recentCombatFailures >= 3) console.log("[NeuralAI] 😎 Характер: осторожный");
  else console.log("[NeuralAI] 😎 Характер: сбалансированный");
}

function hireUnitByType(unitType, goldCost) {
  const aiRes = gameState.aiResources;

  let requiredType;
  if (unitType === "fighter") requiredType = "barracks";
  else if (unitType === "assault") requiredType = "barracks2";
  else if (unitType === "elite") requiredType = "barracks3";
  else return;

  const barracks = gameState.buildings.find(b =>
    b.owner === "ai" &&
    b.type === requiredType &&
    b.active &&
    (b.productionQueue || []).length < 3
  );

  if (!barracks) {
    console.log(`[NeuralAI] ⚠️ Нет ${requiredType} для найма ${unitType}`);
    penalizeBadDecision(); // 🔥 ДОБАВЛЕНО: мгновенный штраф за попытку
    return;
  }
  const cost = unitCosts[unitType] || {};
  if ((aiRes.gold || 0) < (cost.gold || 0) || (aiRes.silicon || 0) < (cost.silicon || 0) || (aiRes.plasma || 0) < (cost.plasma || 0)) {
    console.log(`[NeuralAI] 💰 Недостаточно ресурсов для ${unitType}`);
    return;
  }

  if (lastUnitTypeHired === unitType) {
    repeatHiresInRow++;
    if (repeatHiresInRow >= 4) {
      spamPenaltyCount++;
      if (spamPenaltyCount >= 2) {
        console.warn(`[NeuralAI] 🚨 Штраф за спам ${unitType}`);
        penalizeBadDecision();
        spamPenaltyCount = 0;
      }
    }
  } else {
    repeatHiresInRow = 1;
    lastUnitTypeHired = unitType;
    spamPenaltyCount = Math.max(0, spamPenaltyCount - 1);
  }

  aiEnqueueMilitaryUnit(unitType, barracks);
  aiRes.gold -= cost.gold || 0;
  aiRes.silicon -= cost.silicon || 0;
  aiRes.plasma -= cost.plasma || 0;

  console.log(`[NeuralAI] 🤖 Нанят ${unitType} в ${barracks.type}`);
}

// === НОВАЯ СИСТЕМА: РАСПРЕДЕЛЕНИЕ ЮНИТОВ ПО ГРУППАМ ===
function assignGroupRoles() {
  const aiUnits = gameState.units.filter(u => 
    u.owner === "ai" && 
    ["fighter", "assault", "elite"].includes(u.type) &&
    (!u.commandQueue || u.commandQueue.length === 0)
  );
  
  if (aiUnits.length === 0) return;
  
  // 🔥 РАЗДЕЛЯЕМ ЮНИТОВ НА ГРУППЫ
  const totalUnits = aiUnits.length;
  const groupSize = Math.max(1, Math.floor(totalUnits / 3));
  
  // Группа 1: Атакующие (40% юнитов)
  const attackers = aiUnits.slice(0, groupSize * 1.5);
  
  // Группа 2: Защитники базы (30% юнитов)
  const defenders = aiUnits.slice(groupSize * 1.5, groupSize * 2.5);
  
  // Группа 3: Разведчики/Фланговые (30% юнитов)
  const flankers = aiUnits.slice(groupSize * 2.5);
  
  // 🔥 ДАЁМ КАЖДОЙ ГРУППЕ СВОЮ ЗАДАЧУ
  
  // 1. Атакующие → идут к вражеской базе
  const playerBase = gameState.buildings.find(b => b.owner === "player" && b.type === "base");
  if (playerBase) {
    attackers.forEach(unit => {
      const target = findNearestEnemyTarget(unit);
      if (target && Math.hypot(target.x - playerBase.x, target.y - playerBase.y) < 500) {
        unit.commandQueue = [
          { type: "move", x: target.x, y: target.y },
          { type: "attack", target: target }
        ];
      } else {
        unit.commandQueue = [
          { type: "move", x: playerBase.x, y: playerBase.y },
          { type: "attack", target: null }
        ];
      }
    });
  }
  
  // 2. Защитники → остаются возле базы ИИ
  const aiBase = gameState.buildings.find(b => b.owner === "ai" && b.type === "base");
  if (aiBase) {
    defenders.forEach(unit => {
      const offsetX = (Math.random() - 0.5) * 200;
      const offsetY = (Math.random() - 0.5) * 200;
      unit.commandQueue = [
        { type: "move", x: aiBase.x + offsetX, y: aiBase.y + offsetY },
        { type: "defend", position: { x: aiBase.x, y: aiBase.y } }
      ];
      unit.defending = true;
    });
  }
  
  // 3. Фланговые → идут в обход или разведывают
  flankers.forEach((unit, index) => {
    const angle = (index / flankers.length) * Math.PI * 2;
    const distance = 400;
    const flankX = aiBase.x + Math.cos(angle) * distance;
    const flankY = aiBase.y + Math.sin(angle) * distance;
    
    unit.commandQueue = [
      { type: "move", x: flankX, y: flankY },
      { type: "attack", target: null }
    ];
  });
  
  console.log(`[Tactics] 🎯 Группы: ${attackers.length} атакуют, ${defenders.length} защищают, ${flankers.length} флангуют`);
}

// === МОДИФИЦИРОВАННАЯ ФУНКЦИЯ ВЫБОРА ДЕЙСТВИЙ ===
function assignUnitTargetsIndividually(action) {
  const aiUnits = gameState.units.filter(u => 
    u.owner === "ai" && 
    ["fighter", "assault", "elite"].includes(u.type)
  );
  
  if (aiUnits.length === 0) return;
  
  // 🔥 ЕСЛИ ДЕЙСТВИЕ "ATTACK" ИЛИ "DEFEND" — ИСПОЛЬЗУЕМ ГРУППЫ
  if (action === "attack" || action === "defend" || action === "protect") {
    assignGroupRoles();
    return;
  }
  
  // Для остальных действий — старая логика (все юниты делают одно)
  const enemyUnits = gameState.units.filter(u => u.owner !== "ai");
  const enemyBuildings = gameState.buildings.filter(b => b.owner !== "ai");
  
  for (const unit of aiUnits) {
    if (action === "strikeClusters" && enemyUnits.length > 0) {
      const clusters = [];
      for (const target of enemyUnits) {
        let added = false;
        for (const cluster of clusters) {
          if (Math.hypot(cluster.x - target.x, cluster.y - target.y) < 150) {
            cluster.units.push(target);
            cluster.x = (cluster.x * cluster.units.length + target.x) / (cluster.units.length + 1);
            cluster.y = (cluster.y * cluster.units.length + target.y) / (cluster.units.length + 1);
            added = true; break;
          }
        }
        if (!added) clusters.push({ x: target.x, y: target.y, units: [target] });
      }
      const bestCluster = clusters.reduce((a, b) => (a.units.length > b.units.length ? a : b), clusters[0]);
      if (bestCluster) {
        unit.commandQueue = [{ type: "attack", target: bestCluster.units[Math.floor(Math.random() * bestCluster.units.length)] }];
        processCommandQueue(unit);
      }
    } else {
      const target = enemyUnits.length > 0 ? enemyUnits[Math.floor(Math.random() * enemyUnits.length)] : 
                     (enemyBuildings.length > 0 ? enemyBuildings[Math.floor(Math.random() * enemyBuildings.length)] : null);
      if (target) { 
        unit.commandQueue = [{ type: "attack", target }]; 
        processCommandQueue(unit); 
      }
    }
  }
}

function autoTrainOnDefeat() {
  const N = 5;
  if (trainingData.inputs.length < N || isNeuralTraining) return;
  const recentInputs = trainingData.inputs.slice(-N);
  const recentOutputs = trainingData.outputs.slice(-N);
  const correctedOutputs = recentOutputs.map((output, i) => {
    const action = actions[output.findIndex(v => v === 1)];
    const score = evaluateActionScore(action);
    if (score >= 0) return output;
    const altScores = actions.map((a, idx) => ({ action: a, score: evaluateActionScore(a), index: idx })).sort((a, b) => b.score - a.score);
    const bestAlternative = altScores.find(a => a.score > 0);
    if (bestAlternative) { const newVec = new Array(actions.length).fill(0); newVec[bestAlternative.index] = 1; return newVec; }
    return new Array(actions.length).fill(1 / actions.length);
  });
  isNeuralTraining = true;
  neuralModel.fit(tf.tensor2d(recentInputs), tf.tensor2d(correctedOutputs), {
    epochs: 15, batchSize: 4, shuffle: true,
    callbacks: {
      onEpochEnd: (epoch, logs) => console.log(`[AutoTrain] Эпоха ${epoch + 1} — Потери: ${logs.loss.toFixed(4)}`),
      onTrainEnd: () => {
        isNeuralTraining = false;
        console.log("[NeuralAI] Автообучение на поражении завершено");
        neuralModel.save(LOCAL_MODEL_PATH).then(() => console.log("[NeuralAI] Обновлённая модель сохранена после поражения"));
      }
    }
  });
}

let lastTrainingTime = 0;
const TRAINING_COOLDOWN = 500;

async function processTrainingQueue() {
  // 🔥 ПРОВЕРКА: если уже идет обучение в другой функции, выходим и ждем
  if (isNeuralTraining || trainingQueue.length === 0 || !neuralModel) return;
  
  const now = performance.now();
  if (now - lastTrainingTime < TRAINING_COOLDOWN) {
    setTimeout(processTrainingQueue, TRAINING_COOLDOWN);
    return;
  }
  lastTrainingTime = now;

  isNeuralTraining = true; // 🔒 ЗАХВАТЫВАЕМ ЗАМОК
  const item = trainingQueue.shift();
  
  const input = tf.tensor2d([item.inputs]);
  const target = tf.tensor2d([item.targetOverride || actions.map(a => (a === item.action ? 1 : 0))]);

  try {
    const repeatCount = Math.min(3, Math.ceil(3 / Math.sqrt(Math.max(1, trainingData.inputs.length - trainingData.inputs.indexOf(item.inputs)))));
    
    for (let i = 0; i < repeatCount; i++) {
      await neuralModel.fit(input, target, {
        epochs: 1,
        batchSize: 1,
        shuffle: false
      });
      await new Promise(r => setTimeout(r, 16));
    }

    await saveModelToServer(neuralModel);
  } catch (e) {
    console.error("[NeuralAI] ❌ Ошибка в обучении:", e);
  } finally {
    input.dispose();
    target.dispose();
    
    isNeuralTraining = false; // 🔓 ОТПУСКАЕМ ЗАМОК

    if (trainingQueue.length > 0) {
      setTimeout(processTrainingQueue, 200);
    }
  }
}

function trainNeuralModel(action, inputs) {
  if (!Array.isArray(inputs) || inputs.length !== 82 || !actions.includes(action)) return;
  safePushTraining({ inputs: lastInputArray, targetOverride: actions.map(a => (a === action ? 1 : 0)), action: lastNeuralAction, info: "[reward]" });
  processTrainingQueue();
}

function processAiBuildQueue() {
  if (!aiBuildQueue || aiBuildQueue.length === 0) return;

  const job = aiBuildQueue[0];
  const res = gameState.aiResources || {};
  const cost = job.cost || buildingCosts[job.type] || { gold: 0, silicon: 0, plasma: 0 };

  if (res.gold < (cost.gold || 0) || res.silicon < (cost.silicon || 0) || res.plasma < (cost.plasma || 0)) {
    return;
  }

  let x = job.x || 0;
  let y = job.y || 0;

  if (job.near) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 40;
    x = job.near.x + Math.cos(angle) * dist;
    y = job.near.y + Math.sin(angle) * dist;
  } else {
    const near = gameState.buildings.find(b => b.owner === "ai" && b.type === "base");
    if (near) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 120 + Math.random() * 180;
      x = near.x + Math.cos(angle) * dist;
      y = near.y + Math.sin(angle) * dist;
    }
  }

  const newBuilding = new Building(job.type, "ai", x, y);
  newBuilding.builtAt = performance.now();

  if (typeof BUILDING_ACTIVATION_DELAYS !== 'undefined' && BUILDING_ACTIVATION_DELAYS[job.type]) {
    newBuilding.activationDelay = BUILDING_ACTIVATION_DELAYS[job.type];
  } else {
    newBuilding.activationDelay = 5000;
  }

  gameState.buildings.push(newBuilding);
  gameState.lastAiBuildTime = performance.now();

  gameState.recentBuilds = gameState.recentBuilds || [];
  gameState.recentBuilds.push({
    time: performance.now(),
    type: job.type,
    owner: "ai"
  });

  res.gold -= (cost.gold || 0);
  res.silicon -= (cost.silicon || 0);
  res.plasma -= (cost.plasma || 0);

  if (typeof updateResourceUI === "function") updateResourceUI();

  console.log(`[AI Build] Построено: ${job.type} (Owner: ai)`);

  aiBuildQueue.shift();
}