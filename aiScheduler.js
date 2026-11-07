// ============================================================
// aiScheduler.js — единый управляемый цикл ИИ + реестр таймеров.
// Подключается ПОСЛЕДНИМ (defer), поэтому перекрывает дубликаты
// функций из aiLogic.js и neuralAI.js.
// ============================================================

const AI_TICK_MS = 250;
const NEURAL_AUTO_WORKERS = true; // микро-экономика: в сети нет действия hireWorker
const AI_BUILD_RADIUS = 300;      // правило: только от базы/маяков

const GameTimers = {
  intervals: new Set(),
  timeouts: new Set(),
  setInterval(fn, ms, ...a) { const id = setInterval(fn, ms, ...a); this.intervals.add(id); return id; },
  setTimeout(fn, ms, ...a) { const id = setTimeout(() => { this.timeouts.delete(id); fn(...a); }, ms); this.timeouts.add(id); return id; },
  clearInterval(id) { if (id == null) return; clearInterval(id); this.intervals.delete(id); },
  clearTimeout(id) { if (id == null) return; clearTimeout(id); this.timeouts.delete(id); },
  clearAll() {
    this.intervals.forEach(id => clearInterval(id));
    this.timeouts.forEach(id => clearTimeout(id));
    this.intervals.clear(); this.timeouts.clear();
  }
};
window.GameTimers = GameTimers;

const AI_TASKS = [
  { key: "aiLogic",     period: 1000,  modes: ["single"],           fn: "aiLogic" },
  { key: "buildQ",      period: 1000,  modes: ["single", "neural"], fn: "processBuildQueue" },
  { key: "workers",     period: 1500,  modes: ["single"],           fn: "attemptToHireWorkers" },
  { key: "repairmen",   period: 1500,  modes: ["single"],           fn: "attemptToHireRepairman" },
  { key: "orders",      period: 1500,  modes: ["single"],           fn: "attemptToEnqueueMilitaryOrders" },
  { key: "sale",        period: 10000, modes: ["single", "neural"], fn: "processAISaleQueue" },
  { key: "analyze",     period: 15000, modes: ["single"],           fn: "analyzePlayerBehavior" },
  { key: "adapt",       period: 20000, modes: ["single"],           fn: "adaptDefenses" },
  { key: "neural",      period: 250,   modes: ["neural"],           fn: "updateNeuralAI" },
  { key: "neuralBuild", period: 500,   modes: ["neural"],           fn: "processAiBuildQueue" },
  { key: "neuralEco",   period: 2000,  modes: ["neural"],           fn: "aiNeuralEcoTick" }
];

const AIScheduler = {
  running: false, mode: null, timerId: null, last: {},
  start(mode) {
    this.stop();
    this.mode = mode; this.last = {}; this.running = true;
    this.timerId = GameTimers.setInterval(() => this.tick(), AI_TICK_MS);
    console.log("[AIScheduler] start:", mode, "tick", AI_TICK_MS + "ms");
  },
  stop() {
    if (this.timerId !== null) { GameTimers.clearInterval(this.timerId); this.timerId = null; }
    if (this.running) console.log("[AIScheduler] stop");
    this.running = false;
  },
  tick() {
    if (!this.running) return;
    if (typeof gameStarted === "undefined" || !gameStarted) return;
    if (typeof isPaused !== "undefined" && isPaused) return;
    if (typeof gameState === "undefined" || gameState.gameEnded) { this.stop(); return; }
    if (gameMode !== this.mode) { this.stop(); return; }
    if (this.mode === "neural" && typeof neuralAIActive !== "undefined" && !neuralAIActive) return;
    const now = performance.now();
    for (const t of AI_TASKS) {
      if (!t.modes.includes(this.mode)) continue;
      if (now - (this.last[t.key] || 0) < t.period) continue;
      this.last[t.key] = now;
      const f = window[t.fn];
      if (typeof f !== "function") continue;
      try { f(); } catch (e) { console.error("[AIScheduler] task error:", t.key, e); }
    }
  }
};
window.AIScheduler = AIScheduler;

// ---------- КАНОНИЧЕСКИЕ ВЕРСИИ КОНФЛИКТНЫХ ФУНКЦИЙ ----------

// Полиморфная distance: поддерживает (a,b) и (x1,y1,x2,y2)
window.distance = function (a, b, c, d) {
  if (a && typeof a === "object") return Math.hypot(a.x - b.x, a.y - b.y);
  return Math.hypot(c - a, d - b);
};

// Правило радиуса: только от якорных зданий (база/маяк)
window.isValidAiBuildLocation = function (x, y) {
  if (!isFinite(x) || !isFinite(y)) return false;
  return gameState.buildings.some(b =>
    b.owner === "ai" &&
    ["base", "base2", "base3", "beacon"].includes(b.type) &&
    Math.hypot(b.x - x, b.y - y) <= AI_BUILD_RADIUS
  );
};

// Единая очередь построек для обоих режимов
window.scheduleAIBuilding = function (type, x, y, delay = 500) {
  if (typeof cleanupFailedClusters === "function") cleanupFailedClusters();
  if (!isValidAiBuildLocation(x, y)) return false;
  buildQueue.push({ type, x, y, plannedAt: performance.now(), delay });
  return true;
};

window.getFreeReserveUnits = function () {
  return gameState.units.filter(u =>
    u.owner === "ai" &&
    ["fighter", "assault", "elite"].includes(u.type) &&
    u.health > 0 &&
    (!u.commandQueue || u.commandQueue.length === 0)
  );
};

window.mobilizeDefendersAround = function (pos, radius = 250) {
  if (!pos || typeof pos.x !== "number") return;
  const enemies = gameState.units.filter(u =>
    u.owner === "player" && u.health > 0 &&
    Math.hypot(u.x - pos.x, u.y - pos.y) < radius * 2
  );
  window.getFreeReserveUnits().forEach(unit => {
    if (Math.hypot(unit.x - pos.x, unit.y - pos.y) > radius * 2) return;
    if (enemies.length) {
      const t = enemies.reduce((p, c) =>
        Math.hypot(c.x - unit.x, c.y - unit.y) < Math.hypot(p.x - unit.x, p.y - unit.y) ? c : p);
      unit.commandQueue = [{ type: "move", x: t.x, y: t.y }, { type: "attack", target: t }];
    } else {
      unit.commandQueue = [{ type: "move", x: pos.x + (Math.random() - 0.5) * 60, y: pos.y + (Math.random() - 0.5) * 60 }];
    }
    unit.defending = true;
    if (typeof processCommandQueue === "function") processCommandQueue(unit);
  });
};

window.aiEnqueueMilitaryUnit = function (unitType, building) {
  if (!building || !building.active) return false;
  const req = { fighter: "barracks", assault: "barracks2", elite: "barracks3" }[unitType];
  if (!req || building.type !== req) return false;
  const pt = { fighter: 6000, assault: 12000, elite: 25000 }[unitType];
  if (!building.productionQueue) building.productionQueue = [];
  if (building.productionQueue.length >= (building.productionLimit || 3)) return false;
  const last = building.productionQueue[building.productionQueue.length - 1];
  const timeStart = last ? last.timeStart + last.productionTime : performance.now();
  building.productionQueue.push({ unitType, timeStart, productionTime: pt });
  return true;
};

// Оплата при постановке заказа; спавн — единый processProductionQueue в gameLoop
window.attemptToEnqueueMilitaryOrders = function () {
  if (gameMode !== "single") return;
  const list = gameState.buildings.filter(b =>
    b.owner === "ai" && b.active &&
    ["barracks", "barracks2", "barracks3"].includes(b.type)
  );
  for (const b of list) {
    const type = b.type === "barracks" ? "fighter" : b.type === "barracks2" ? "assault" : "elite";
    if (typeof canHireUnit === "function" && !canHireUnit(type)) continue;
    if (!b.productionQueue) b.productionQueue = [];
    if (b.productionQueue.length >= (b.productionLimit || 3)) continue;
    const cost = unitCosts[type];
    if (!canSpendResources(cost, "ai")) continue;
    if (!window.aiEnqueueMilitaryUnit(type, b)) continue;
    gameState.aiResources.gold -= cost.gold || 0;
    gameState.aiResources.silicon -= cost.silicon || 0;
    gameState.aiResources.plasma -= cost.plasma || 0;
    if (typeof updateResourceUI === "function") updateResourceUI();
  }
};

// Отключены: спавн и оплата больше не дублируются
window.processAIMilitaryProductionQueue = function () {};
window.updateAIProductionQueues = function () {};

// Микро-экономика нейро-режима (решения о зданиях/бое остаются за сетью)
window.aiNeuralEcoTick = function () {
  if (!NEURAL_AUTO_WORKERS) return;
  gameState.buildings.forEach(b => {
    if (b.owner !== "ai" || !b.active) return;
    if (b.type === "warehouse") {
      if (Array.isArray(b.productionQueue)) b.productionQueue.length = 0;
      let guard = 0;
      while ((b.workers || 0) < (b.maxDeliveryWorkers || 5) && guard++ < 5 && canSpendResources(WORKER_COST, "ai")) aiHireWorker(b);
    } else if (b.type === "repairWorkshop") {
      let guard = 0;
      while ((b.repairman || 0) < 2 && guard++ < 2 && canSpendResources(REPAIRMAN_COST, "ai")) aiHireRepairMan(b);
    }
  });
};

window.initAILogic = function () { window.initAILogic._inited = true; };
window.gameLoopAI = function () {};

window.stopAllIntervals = function () {
  AIScheduler.stop();
  GameTimers.clearAll();
};
